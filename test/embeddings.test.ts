/** Batched embedding: the API accepts an array, so indexing batches per call. */
import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAiEmbedder, embedAll } from "../src/services/embeddings.js";
import { createFaqService } from "../src/services/faq.js";
import { createRagService } from "../src/services/rag.js";
import type { VectorStore } from "../src/services/qdrant.js";
import { config, store } from "./fixtures.js";

/** Returns one vector per input, in request order unless configured otherwise. */
async function withEmbeddingApi<T>(
  run: (inputs: string[][]) => Promise<T>,
  options: { reverse?: boolean } = {},
) {
  const originalFetch = globalThis.fetch;
  const inputs: string[][] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    inputs.push(body.input);
    const data = body.input.map((text, index) => ({
      index,
      embedding: [text.length],
    }));
    return new Response(
      JSON.stringify({ data: options.reverse ? data.reverse() : data }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    return await run(inputs);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a batch of texts is one request", async () => {
  await withEmbeddingApi(async (inputs) => {
    const embedder = createOpenAiEmbedder(config);
    const vectors = await embedder.embedBatch!(["a", "bb", "ccc"]);
    assert.deepEqual(inputs, [["a", "bb", "ccc"]]);
    assert.deepEqual(vectors, [[1], [2], [3]]);
  });
});

test("a batch larger than EMBEDDING_BATCH_SIZE is chunked", async () => {
  await withEmbeddingApi(async (inputs) => {
    const embedder = createOpenAiEmbedder({
      ...config,
      EMBEDDING_BATCH_SIZE: 2,
    });
    const texts = ["a", "bb", "ccc", "dddd", "eeeee"];
    assert.deepEqual(await embedder.embedBatch!(texts), [
      [1],
      [2],
      [3],
      [4],
      [5],
    ]);
    assert.deepEqual(inputs, [["a", "bb"], ["ccc", "dddd"], ["eeeee"]]);
  });
});

test("vectors are matched to their text by index, not by arrival order", async () => {
  await withEmbeddingApi(
    async () => {
      const embedder = createOpenAiEmbedder(config);
      // Response order is not guaranteed, so pairing by position attaches vectors
      // to the wrong documents.
      assert.deepEqual(await embedder.embedBatch!(["a", "bb", "ccc"]), [
        [1],
        [2],
        [3],
      ]);
    },
    { reverse: true },
  );
});

test("a short response is an error rather than a hole in the index", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => createOpenAiEmbedder(config).embedBatch!(["a", "b"]),
      /covered 1 of 2 inputs/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("embedAll falls back to single calls for an embedder without batching", async () => {
  const asked: string[] = [];
  const vectors = await embedAll(
    {
      async embed(text) {
        asked.push(text);
        return [text.length];
      },
    },
    ["a", "bb"],
  );
  assert.deepEqual(asked, ["a", "bb"]);
  assert.deepEqual(vectors, [[1], [2]]);
});

test("indexing documents makes one embeddings request, not one per document", async () => {
  await withEmbeddingApi(async (inputs) => {
    const upserted: Array<{ id: string; vector: number[] }> = [];
    const recordingStore: VectorStore = {
      ...store,
      async upsert(points) {
        upserted.push(...points.map(({ id, vector }) => ({ id, vector })));
      },
    };
    const rag = createRagService(
      config,
      createOpenAiEmbedder(config),
      recordingStore,
      {
        async listTools() {
          return [];
        },
        async callTool() {
          throw new Error("no");
        },
      },
    );
    const result = await rag.index({
      documents: [
        { id: "D1", text: "a", metadata: {} },
        { id: "D2", text: "bb", metadata: {} },
      ],
    });
    assert.deepEqual(result, { indexed: 2 });
    assert.deepEqual(inputs, [["a", "bb"]]);
    assert.deepEqual(upserted, [
      { id: "D1", vector: [1] },
      { id: "D2", vector: [2] },
    ]);
  });
});

test("a FAQ reindex embeds each batch in one request", async () => {
  await withEmbeddingApi(async (inputs) => {
    const faq = createFaqService(createOpenAiEmbedder(config), store, 2);
    await faq.reindex({
      items: [
        { id: "A", question: "q1", answer: "a1", enabled: true },
        { id: "B", question: "q2", answer: "a2", enabled: true },
        { id: "C", question: "q3", answer: "a3", enabled: true },
      ],
    });
    for (let tick = 0; tick < 100; tick += 1) {
      if ((await faq.reindexStatus()).status === "completed") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const status = await faq.reindexStatus();
    assert.equal(status.status, "completed");
    // Two chunks at a batch size of two, not three separate calls.
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0]?.length, 2);
    assert.equal(inputs[1]?.length, 1);
  });
});
