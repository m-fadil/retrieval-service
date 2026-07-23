import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import type { AppConfig } from "../config.js";

export interface SearchHit {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown> | null;
}

export interface VectorStore {
  health(): Promise<boolean>;
  upsert(
    points: Array<{
      id: string;
      vector: number[];
      payload: Record<string, unknown>;
    }>,
  ): Promise<void>;
  get(id: string): Promise<SearchHit | null>;
  delete(ids: string[]): Promise<void>;
  deleteBySource(source: string): Promise<void>;
  /**
   * Deletes every point of `source` except those whose original id is in
   * `keepIds`. Lets a reindex converge without a window where the index is
   * empty.
   */
  deleteBySourceExcept(source: string, keepIds: string[]): Promise<void>;
  /** Counts what deleteBySourceExcept would remove, for reindex reporting. */
  countBySourceExcept(source: string, keepIds: string[]): Promise<number>;
  /**
   * Drops the whole collection — every source, not just FAQ. Exists for
   * embedding model/dimension changes, where all stored vectors are invalid.
   */
  dropCollection(): Promise<void>;
  search(
    vector: number[],
    limit: number,
    options?: { source?: string },
  ): Promise<SearchHit[]>;
}

/** Matches points of `source` whose original id is not in `keepIds`. */
function staleFilter(source: string, keepIds: string[]) {
  return {
    must: [{ key: "source", match: { value: source } }],
    ...(keepIds.length
      ? { must_not: [{ key: "original_id", match: { any: keepIds } }] }
      : {}),
  };
}

/**
 * True when Qdrant rejected the call because the collection does not exist —
 * e.g. before the first upsert lazily creates it, or right after
 * dropCollection. Reads and deletes treat that as an empty collection.
 */
export function isMissingCollection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

export function pointId(id: string): string {
  const hex = createHash("sha256").update(id).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createQdrantStore(
  config: Pick<
    AppConfig,
    "QDRANT_URL" | "QDRANT_COLLECTION" | "QDRANT_API_KEY" | "QDRANT_TIMEOUT_MS"
  >,
): VectorStore {
  const client = new QdrantClient({
    url: config.QDRANT_URL,
    apiKey: config.QDRANT_API_KEY,
    timeout: config.QDRANT_TIMEOUT_MS,
  });
  let collectionReady = false;

  async function ensureCollection(vectorSize: number) {
    if (collectionReady) return;
    const { exists } = await client.collectionExists(config.QDRANT_COLLECTION);
    let created = false;
    if (!exists) {
      try {
        await client.createCollection(config.QDRANT_COLLECTION, {
          vectors: { size: vectorSize, distance: "Cosine" },
        });
        created = true;
      } catch (error) {
        // A concurrent writer may have created it between the existence check
        // and this call; only that race is tolerated — fall through to the
        // dimension check below, which also validates the racing creation.
        const raced = await client.collectionExists(config.QDRANT_COLLECTION);
        if (!raced.exists) throw error;
      }
    }
    if (!created) {
      // A dimension change (e.g. a different embedding model) would otherwise
      // surface as opaque upsert failures much later.
      const info = await client.getCollection(config.QDRANT_COLLECTION);
      const params = info.config?.params?.vectors;
      const existingSize =
        params && typeof params === "object" && "size" in params
          ? Number((params as { size?: number }).size)
          : undefined;
      if (existingSize !== undefined && existingSize !== vectorSize) {
        throw new Error(
          `Collection ${config.QDRANT_COLLECTION} has vector size ${existingSize} but the embedding model produced ${vectorSize}. Recreate the collection or restore the previous EMBEDDING_MODEL.`,
        );
      }
    }
    // Required for the source filter used by search and reindex to stay fast.
    await client.createPayloadIndex(config.QDRANT_COLLECTION, {
      field_name: "source",
      field_schema: "keyword",
      wait: true,
    });
    collectionReady = true;
  }

  return {
    async health() {
      try {
        await client.getCollections();
        return true;
      } catch {
        return false;
      }
    },
    async upsert(points) {
      const vectorSize = points[0]?.vector.length;
      if (!vectorSize) return;
      await ensureCollection(vectorSize);
      await client.upsert(config.QDRANT_COLLECTION, {
        points: points.map((point) => ({
          ...point,
          id: pointId(point.id),
          payload: { original_id: point.id, ...point.payload },
        })),
      });
    },
    async get(id) {
      try {
        const [point] = await client.retrieve(config.QDRANT_COLLECTION, {
          ids: [pointId(id)],
          with_payload: true,
        });
        return point ? { id: point.id, payload: point.payload } : null;
      } catch (error) {
        if (isMissingCollection(error)) return null;
        throw error;
      }
    },
    async delete(ids) {
      if (!ids.length) return;
      try {
        await client.delete(config.QDRANT_COLLECTION, {
          points: ids.map(pointId),
        });
      } catch (error) {
        if (!isMissingCollection(error)) throw error;
      }
    },
    async deleteBySource(source) {
      try {
        await client.delete(config.QDRANT_COLLECTION, {
          filter: {
            must: [{ key: "source", match: { value: source } }],
          },
        });
      } catch (error) {
        if (!isMissingCollection(error)) throw error;
      }
    },
    async countBySourceExcept(source, keepIds) {
      try {
        const { count } = await client.count(config.QDRANT_COLLECTION, {
          filter: staleFilter(source, keepIds),
          exact: true,
        });
        return count;
      } catch (error) {
        if (isMissingCollection(error)) return 0;
        throw error;
      }
    },
    async deleteBySourceExcept(source, keepIds) {
      try {
        await client.delete(config.QDRANT_COLLECTION, {
          filter: staleFilter(source, keepIds),
        });
      } catch (error) {
        if (!isMissingCollection(error)) throw error;
      }
    },
    async dropCollection() {
      await client.deleteCollection(config.QDRANT_COLLECTION);
      // The next upsert recreates the collection at the dimension the current
      // embedding model actually produces.
      collectionReady = false;
    },
    async search(vector, limit, options) {
      try {
        const result = await client.query(config.QDRANT_COLLECTION, {
          query: vector,
          limit,
          with_payload: true,
          ...(options?.source
            ? {
                filter: {
                  must: [{ key: "source", match: { value: options.source } }],
                },
              }
            : {}),
        });
        return result.points.map((point) => ({
          id: point.id,
          score: point.score,
          payload: point.payload,
        }));
      } catch (error) {
        if (isMissingCollection(error)) return [];
        throw error;
      }
    },
  };
}
