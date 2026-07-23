import { createHash } from "node:crypto";
import type { Faq, FaqBulkRequest, FaqReindexRequest } from "../schemas/faq.js";
import type { Embedder } from "./embeddings.js";
import type { VectorStore } from "./qdrant.js";

export type FaqWriteResult = {
  upserted: number;
  skipped: number;
  deleted: number;
};
export type FaqBulkResult = FaqWriteResult & { processed: number };
export type FaqReindexStart = { status: "accepted" } | { status: "processing" };
export type FaqReindexStatus =
  | { status: "not_started" }
  | {
      status: "processing";
      started_at: string;
      processed: number;
      total: number;
    }
  | (FaqBulkResult & {
      status: "completed";
      started_at: string;
      finished_at: string;
      total: number;
    })
  | {
      status: "failed";
      started_at: string;
      finished_at: string;
      processed: number;
      total: number;
      error: string;
    };

/** Just enough of a logger for the fire-and-forget reindex to report failure. */
export type FaqLog = {
  error: (details: Record<string, unknown>, message?: string) => void;
};

export interface FaqService {
  upsert(id: string, faq: Faq): Promise<FaqWriteResult>;
  delete(id: string): Promise<{ deleted: number }>;
  bulk(input: FaqBulkRequest): Promise<FaqBulkResult>;
  reindex(input: FaqReindexRequest, log?: FaqLog): Promise<FaqReindexStart>;
  /** Drops the whole collection, then reindexes. For embedding model changes. */
  recreate(input: FaqReindexRequest, log?: FaqLog): Promise<FaqReindexStart>;
  reindexStatus(): Promise<FaqReindexStatus>;
}

export const FAQ_SOURCE = "frappe_faq";

export function faqPointId(id: string): string {
  return `${FAQ_SOURCE}:${id}`;
}

export function faqContent(
  faq: Pick<Faq, "question" | "answer" | "category">,
): string {
  return [
    `Question: ${faq.question}`,
    `Answer: ${faq.answer}`,
    faq.category ? `Category: ${faq.category}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function faqContentHash(
  faq: Pick<Faq, "question" | "answer" | "category">,
): string {
  return createHash("sha256").update(faqContent(faq)).digest("hex");
}

export function createFaqService(
  embedder: Embedder,
  store: VectorStore,
): FaqService {
  let reindexState: FaqReindexStatus = { status: "not_started" };

  async function upsert(id: string, faq: Faq): Promise<FaqWriteResult> {
    if (!faq.enabled) return { ...(await remove(id)), upserted: 0, skipped: 0 };
    const content = faqContent(faq);
    const content_hash = faqContentHash(faq);
    const existing = await store.get(faqPointId(id));
    if (existing?.payload?.content_hash === content_hash) {
      return { upserted: 0, skipped: 1, deleted: 0 };
    }
    await store.upsert([
      {
        id: faqPointId(id),
        vector: await embedder.embed(content),
        payload: {
          text: content,
          source: FAQ_SOURCE,
          source_id: id,
          question: faq.question,
          answer: faq.answer,
          category: faq.category,
          enabled: faq.enabled,
          modified: faq.modified,
          content_hash,
        },
      },
    ]);
    return { upserted: 1, skipped: 0, deleted: 0 };
  }

  async function remove(id: string) {
    await store.delete([faqPointId(id)]);
    return { deleted: 1 };
  }

  async function runReindex(input: FaqReindexRequest, log?: FaqLog) {
    if (reindexState.status !== "processing") return;
    const started = reindexState;
    const total: FaqBulkResult = {
      processed: 0,
      upserted: 0,
      skipped: 0,
      deleted: 0,
    };
    try {
      // Write the new generation first, then retire whatever it did not cover.
      // Deleting up front (the previous behaviour) left the index empty or
      // half-populated for the whole run, and permanently so if any embedding
      // call failed part-way through.
      const keepIds: string[] = [];
      for (const item of input.items) {
        const result = await upsert(item.id, item);
        if (item.enabled) keepIds.push(faqPointId(item.id));
        total.processed += 1;
        total.upserted += result.upserted;
        total.skipped += result.skipped;
        total.deleted += result.deleted;
        reindexState = { ...started, processed: total.processed };
      }
      const staleBefore = await store.countBySourceExcept(FAQ_SOURCE, keepIds);
      await store.deleteBySourceExcept(FAQ_SOURCE, keepIds);
      total.deleted += staleBefore;
      reindexState = {
        ...total,
        status: "completed",
        started_at: started.started_at,
        finished_at: new Date().toISOString(),
        total: input.items.length,
      };
    } catch (error) {
      // Also logged: the state below is only visible to whoever happens to
      // poll /faq/reindex/status.
      log?.error({ err: error }, "faq reindex failed");
      reindexState = {
        status: "failed",
        started_at: started.started_at,
        finished_at: new Date().toISOString(),
        processed: total.processed,
        total: input.items.length,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Claims the reindex state machine synchronously — before any await — so a
   * concurrent reindex/recreate arriving mid-operation sees "processing"
   * instead of starting a second run.
   */
  function claimReindex(input: FaqReindexRequest) {
    const claimed = {
      status: "processing" as const,
      started_at: new Date().toISOString(),
      processed: 0,
      total: input.items.length,
    };
    reindexState = claimed;
    return claimed;
  }

  return {
    upsert,
    delete: remove,
    async bulk(input) {
      const total: FaqBulkResult = {
        processed: input.items.length,
        upserted: 0,
        skipped: 0,
        deleted: 0,
      };
      for (const item of input.items) {
        if (item.op === "delete") {
          total.deleted += (await remove(item.id)).deleted;
          continue;
        }
        const result = await upsert(item.id, item);
        total.upserted += result.upserted;
        total.skipped += result.skipped;
        total.deleted += result.deleted;
      }
      return total;
    },
    async reindex(input, log) {
      if (reindexState.status === "processing") return { status: "processing" };
      claimReindex(input);
      void runReindex(input, log);
      return { status: "accepted" };
    },
    async recreate(input, log) {
      if (reindexState.status === "processing") return { status: "processing" };
      // The state must be claimed before the drop's await: a reindex request
      // arriving during the drop would otherwise pass its own guard and run
      // concurrently against a collection being yanked out from under it.
      const claimed = claimReindex(input);
      try {
        // The collection is dropped wholesale — every source, not just FAQ.
        // This endpoint exists for embedding model/dimension changes, where
        // all stored vectors are invalid; non-FAQ documents must be re-sent
        // via POST /index afterwards.
        await store.dropCollection();
      } catch (error) {
        // Release the claim as a failed run, or the state machine would stay
        // "processing" forever and refuse every later reindex.
        reindexState = {
          status: "failed",
          started_at: claimed.started_at,
          finished_at: new Date().toISOString(),
          processed: 0,
          total: input.items.length,
          error: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
      void runReindex(input, log);
      return { status: "accepted" };
    },
    async reindexStatus() {
      return reindexState;
    },
  };
}
