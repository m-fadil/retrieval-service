import { createHash } from "node:crypto";
import type { Faq, FaqBulkRequest, FaqReindexRequest } from "../schemas/faq.js";
import { embedAll, type Embedder } from "./embeddings.js";
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

/** Minimal logger surface the fire-and-forget reindex needs to report failure. */
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

type FaqItem = Faq & { id: string };

/** Splits a list into fixed-size chunks, order-preserving. */
function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    chunks.push(items.slice(at, at + size));
  }
  return chunks;
}

/** Runs of consecutive items sharing an op, which preserves bulk ordering. */
function runsByOp<T extends { op: "upsert" | "delete" }>(items: T[]) {
  const runs: Array<{ op: T["op"]; items: T[] }> = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (last?.op === item.op) last.items.push(item);
    else runs.push({ op: item.op, items: [item] });
  }
  return runs;
}

export function createFaqService(
  embedder: Embedder,
  store: VectorStore,
  /**
   * Entries per embedding batch and per progress update. Also bounds resident
   * vector count during a reindex.
   */
  batchSize = 64,
): FaqService {
  let reindexState: FaqReindexStatus = { status: "not_started" };

  /**
   * Writes a group in two calls: one embeddings request for the entries whose
   * content changed, then one upsert. Per-entry embedding turns a few hundred
   * FAQ entries into a few hundred sequential provider round trips.
   */
  async function writeBatch(
    items: FaqItem[],
  ): Promise<FaqWriteResult & { keepIds: string[] }> {
    const keepIds: string[] = [];
    const disabled: string[] = [];
    const pending: Array<{ item: FaqItem; content: string; hash: string }> = [];
    let skipped = 0;

    for (const item of items) {
      if (!item.enabled) {
        disabled.push(faqPointId(item.id));
        continue;
      }
      keepIds.push(faqPointId(item.id));
      const content = faqContent(item);
      const hash = faqContentHash(item);
      const existing = await store.get(faqPointId(item.id));
      if (existing?.payload?.content_hash === hash) {
        skipped += 1;
        continue;
      }
      pending.push({ item, content, hash });
    }

    if (pending.length) {
      const vectors = await embedAll(
        embedder,
        pending.map((entry) => entry.content),
      );
      await store.upsert(
        pending.map((entry, at) => ({
          id: faqPointId(entry.item.id),
          vector: vectors[at]!,
          payload: {
            text: entry.content,
            source: FAQ_SOURCE,
            source_id: entry.item.id,
            question: entry.item.question,
            answer: entry.item.answer,
            category: entry.item.category,
            enabled: entry.item.enabled,
            modified: entry.item.modified,
            content_hash: entry.hash,
          },
        })),
      );
    }
    if (disabled.length) await store.delete(disabled);

    return {
      upserted: pending.length,
      skipped,
      deleted: disabled.length,
      keepIds,
    };
  }

  async function upsert(id: string, faq: Faq): Promise<FaqWriteResult> {
    const { keepIds: _keepIds, ...result } = await writeBatch([{ ...faq, id }]);
    return result;
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
      // Write the new generation, then retire what it did not cover. Deleting
      // first leaves the index empty or partial for the length of the run, and
      // permanently so if an embedding call fails mid-run.
      const keepIds: string[] = [];
      for (const chunk of chunked(input.items, batchSize)) {
        const result = await writeBatch(chunk);
        keepIds.push(...result.keepIds);
        total.processed += chunk.length;
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
      // Logged as well as recorded: the state below is visible only to a caller
      // polling /faq/reindex/status.
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
   * Claims the reindex state machine synchronously, before any await, so a
   * concurrent reindex/recreate observes "processing" rather than starting a
   * second run.
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
      // Grouped by op so a run of upserts shares one embeddings request.
      // Grouping consecutive runs only, not all ops, preserves caller ordering —
      // which matters when one payload deletes and re-adds the same id.
      for (const run of runsByOp(input.items)) {
        if (run.op === "delete") {
          await store.delete(run.items.map((item) => faqPointId(item.id)));
          total.deleted += run.items.length;
          continue;
        }
        for (const chunk of chunked(run.items as FaqItem[], batchSize)) {
          const result = await writeBatch(chunk);
          total.upserted += result.upserted;
          total.skipped += result.skipped;
          total.deleted += result.deleted;
        }
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
      // Claim precedes the drop's await: otherwise a reindex arriving during the
      // drop passes its own guard and runs against a collection being deleted.
      const claimed = claimReindex(input);
      try {
        // Drops every source, not just FAQ. Scoped to embedding model/dimension
        // changes, where all stored vectors are invalid; non-FAQ documents must be
        // re-sent via POST /index afterwards.
        await store.dropCollection();
      } catch (error) {
        // Releases the claim as a failed run; otherwise the state machine stays
        // "processing" and refuses every later reindex.
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
