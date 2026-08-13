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
   * Deletes every point of `source` whose original id is absent from `keepIds`.
   * Lets a reindex converge with no window where the index is empty.
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
 * True when Qdrant rejected the call for a missing collection — before the first
 * upsert lazily creates it, or after dropCollection. Reads and deletes treat
 * that as an empty collection.
 */
export function isMissingCollection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, data } = error as {
    status?: unknown;
    data?: { status?: { error?: unknown } };
  };
  if (status !== 404) return false;
  // Status alone is insufficient: a misconfigured QDRANT_URL (wrong path, proxy)
  // also returns 404, and reading that as an empty collection makes every search
  // return nothing. Requires Qdrant's own error body, e.g.
  // "Not found: Collection `knowledge_base` doesn't exist!".
  const detail = data?.status?.error;
  return (
    typeof detail === "string" && /collection.*doesn't exist/i.test(detail)
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
        // Tolerates exactly one race: a concurrent writer creating the collection
        // between the existence check and this call. Falls through to the
        // dimension check, which validates that creation too.
        const raced = await client.collectionExists(config.QDRANT_COLLECTION);
        if (!raced.exists) throw error;
      }
    }
    if (!created) {
      // Fails fast on a dimension change (a different embedding model), which
      // otherwise surfaces as opaque upsert errors much later.
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
    // Required for the source filter in search and reindex to stay indexed.
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
        // Without wait, Qdrant acknowledges an upsert before it is searchable.
        // The FAQ write path reads its own writes — dedup searches immediately
        // after an upsert — so an early return reports points the next search
        // cannot see.
        wait: true,
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
      // The next upsert recreates the collection at the current embedding
      // model's dimension.
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
