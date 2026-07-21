import test from "node:test";
import assert from "node:assert/strict";
import { createFaqService } from "../src/services/faq.js";
import type { VectorStore } from "../src/services/qdrant.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createStore(): VectorStore {
  return {
    async health() {
      return true;
    },
    async upsert() {},
    async get() {
      return null;
    },
    async delete() {},
    async deleteBySource() {},
    async deleteBySourceExcept() {},
    async countBySourceExcept() {
      return 0;
    },
    async search() {
      return [];
    },
  };
}

test("faq singleton reindex status is not started before a run", async () => {
  const faq = createFaqService(
    {
      async embed() {
        return [1, 2, 3];
      },
    },
    createStore(),
  );

  assert.deepEqual(await faq.reindexStatus(), { status: "not_started" });
});

test("faq async reindex reports processing and completes", async () => {
  const gate = deferred();
  const store: VectorStore = {
    async health() {
      return true;
    },
    async upsert() {},
    async get() {
      return null;
    },
    async delete() {},
    async deleteBySource() {},
    async deleteBySourceExcept() {},
    async countBySourceExcept() {
      return 0;
    },
    async search() {
      return [];
    },
  };
  const faq = createFaqService(
    {
      async embed() {
        await gate.promise;
        return [1, 2, 3];
      },
    },
    store,
  );

  const start = await faq.reindex({
    items: [{ id: "FAQ-1", question: "Q", answer: "A", enabled: true }],
  });
  assert.deepEqual(start, { status: "accepted" });

  const second = await faq.reindex({
    items: [{ id: "FAQ-2", question: "Q", answer: "A", enabled: true }],
  });
  assert.deepEqual(second, { status: "processing" });

  const processing = await faq.reindexStatus();
  assert.equal(processing.status, "processing");
  assert.match(processing.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(processing.processed, 0);
  assert.equal(processing.total, 1);

  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const completed = await faq.reindexStatus();
  assert.equal(completed.status, "completed");
  assert.match(completed.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(completed.finished_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(completed.processed, 1);
  assert.equal(completed.total, 1);
  assert.equal(completed.upserted, 1);
});

test("faq singleton reindex status reports failures", async () => {
  const faq = createFaqService(
    {
      async embed() {
        throw new Error("embedding unavailable");
      },
    },
    createStore(),
  );

  await faq.reindex({
    items: [{ id: "FAQ-1", question: "Q", answer: "A", enabled: true }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const failed = await faq.reindexStatus();
  assert.equal(failed.status, "failed");
  assert.match(failed.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(failed.finished_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(failed.error, "embedding unavailable");
});
