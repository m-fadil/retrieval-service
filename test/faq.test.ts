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
    async dropCollection() {},
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
    async dropCollection() {},
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

test("faq recreate drops the collection before reindexing", async () => {
  const calls: string[] = [];
  const store: VectorStore = {
    ...createStore(),
    async dropCollection() {
      calls.push("drop");
    },
    async upsert() {
      calls.push("upsert");
    },
  };
  const faq = createFaqService(
    {
      async embed() {
        return [1, 2, 3];
      },
    },
    store,
  );

  const start = await faq.recreate({
    items: [{ id: "FAQ-1", question: "Q", answer: "A", enabled: true }],
  });
  assert.deepEqual(start, { status: "accepted" });

  for (let i = 0; i < 50 && !calls.includes("upsert"); i += 1) {
    await new Promise((tick) => setImmediate(tick));
  }
  assert.equal(calls[0], "drop");
  assert.ok(calls.includes("upsert"));
  const status = await faq.reindexStatus();
  assert.equal(status.status, "completed");
});

test("faq recreate refuses while a reindex is processing", async () => {
  const gate = deferred();
  const dropped: string[] = [];
  const store: VectorStore = {
    ...createStore(),
    async dropCollection() {
      dropped.push("drop");
    },
    async upsert() {
      await gate.promise;
    },
  };
  const faq = createFaqService(
    {
      async embed() {
        return [1, 2, 3];
      },
    },
    store,
  );

  await faq.reindex({
    items: [{ id: "FAQ-1", question: "Q", answer: "A", enabled: true }],
  });
  const second = await faq.recreate({
    items: [{ id: "FAQ-1", question: "Q", answer: "A", enabled: true }],
  });
  assert.deepEqual(second, { status: "processing" });
  // The guard must reject before dropping: a concurrent recreate must not
  // yank the collection out from under the in-flight reindex.
  assert.equal(dropped.length, 0);
  gate.resolve();
});
