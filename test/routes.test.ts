/** The HTTP surface: validation, status codes and hand-offs per route. */
import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.js";
import { createRagService } from "../src/services/rag.js";
import type { VectorStore } from "../src/services/qdrant.js";
import {
  authHeaders,
  config,
  embedder,
  faq,
  finalAnswer,
  rag,
  store,
  stubDispatcher,
} from "./fixtures.js";

test("health route reports qdrant status", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, qdrant: true });
});

test("index route validates and indexes documents", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "POST",
    url: "/index",
    headers: authHeaders,
    payload: { documents: [{ id: "1", text: "hello" }] },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { indexed: 1 });
});

test("search route applies default min_score and omits answer", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "POST",
    url: "/search",
    headers: authHeaders,
    payload: { question: "hello" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.includes('"answer"'), false);
  assert.deepEqual(response.json(), {
    matches: [{ id: "hit-1", score: 0.85, payload: { text: "hello" } }],
  });
});

test("search route accepts explicit lower min_score", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "POST",
    url: "/search",
    headers: authHeaders,
    payload: { question: "hello", min_score: 0.1 },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    matches: [
      { id: "hit-1", score: 0.85, payload: { text: "hello" } },
      { id: "hit-2", score: 0.2, payload: { text: "unrelated" } },
    ],
  });
});

test("search route forwards source to the service", async () => {
  let received: string | undefined;
  const app = buildApp({
    config,
    store,
    faq,
    rag: {
      ...rag,
      async search(input) {
        received = input.source;
        return { matches: [] };
      },
    },
  });
  const response = await app.inject({
    method: "POST",
    url: "/search",
    headers: authHeaders,
    payload: { question: "hello", source: "frappe_faq" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(received, "frappe_faq");
});

test("rag search scopes the vector query to the requested source", async () => {
  const optionsSeen: Array<{ source?: string } | undefined> = [];
  const scopedStore: VectorStore = {
    ...store,
    async search(_vector, _limit, options) {
      optionsSeen.push(options);
      return [
        {
          id: "faq-1",
          score: 0.9,
          payload: { text: "faq", source: "frappe_faq" },
        },
      ];
    },
  };
  const service = createRagService(config, embedder, scopedStore, {
    async listTools() {
      return [];
    },
    async callTool() {
      throw new Error("not used");
    },
  });
  const result = await service.search({
    question: "q",
    limit: 3,
    min_score: 0.7,
    source: "frappe_faq",
  });
  assert.deepEqual(optionsSeen, [{ source: "frappe_faq" }]);
  assert.equal(result.matches.length, 1);
});

test("chat async route accepts the job and hands off to the dispatcher", async () => {
  const dispatched: Array<{
    question: string;
    actor?: string;
    envelope: { request_id: string; session_id: string };
  }> = [];
  const app = buildApp({
    config,
    store,
    rag,
    faq,
    dispatcher: stubDispatcher(async (input, envelope) => {
      dispatched.push({
        question: input.question,
        actor: input.actor,
        envelope,
      });
    }),
  });
  const response = await app.inject({
    method: "POST",
    url: "/chat/async",
    headers: authHeaders,
    payload: {
      message: "How do I check in?",
      type: "staff",
      staff_id: "STAFF-1",
      job_id: "JOB-1",
      actor: "trainer@example.com",
      request_id: "req-1",
      session_id: "CHAT-1",
    },
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { accepted: true, request_id: "req-1" });
  assert.deepEqual(dispatched, [
    {
      question: "How do I check in?",
      actor: "trainer@example.com",
      envelope: { request_id: "req-1", session_id: "CHAT-1" },
    },
  ]);
});

test("chat async route rejects a missing correlation envelope", async () => {
  let dispatched = 0;
  const app = buildApp({
    config,
    store,
    rag,
    faq,
    dispatcher: stubDispatcher(async () => {
      dispatched += 1;
    }),
  });
  const response = await app.inject({
    method: "POST",
    url: "/chat/async",
    headers: authHeaders,
    payload: { message: "hi", session_id: "CHAT-1" },
  });
  assert.ok(response.statusCode >= 400);
  assert.equal(dispatched, 0);
});

test("answer route validates and answers", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "POST",
    url: "/answer",
    headers: authHeaders,
    payload: { question: "hello" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    answer: "answer:hello",
    route: "hybrid",
    needs_admin: false,
    reason: "tool_match",
    sources: [],
  });
});

test("answer route logs compose usage", async () => {
  const events: Array<{ level: string; value: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: finalAnswer("safe answer") }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) satisfies typeof fetch;
  try {
    const service = createRagService(config, embedder, store);
    const app = buildApp({
      config,
      store,
      faq,
      rag: {
        ...service,
        async answer(input) {
          return service.answer(input, {
            debug() {},
            info(value: unknown) {
              events.push({ level: "info", value });
            },
            error() {},
          });
        },
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/answer",
      headers: authHeaders,
      payload: { question: "hello" },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(
      events.some(({ level, value }) => {
        const event = value as Record<string, unknown>;
        return (
          level === "info" &&
          event.stage === "answer.compose" &&
          event.prompt_tokens === 11 &&
          event.completion_tokens === 7 &&
          event.total_tokens === 18
        );
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("query route remains backward-compatible and answers", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "POST",
    url: "/query",
    headers: authHeaders,
    payload: { question: "hello" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    answer: "answer:hello",
    route: "hybrid",
    needs_admin: false,
    reason: "tool_match",
    sources: [],
  });
});

test("faq routes reject missing auth", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "PUT",
    url: "/faq/FAQ-1",
    payload: { question: "Q", answer: "A" },
  });
  assert.equal(response.statusCode, 401);
});

test("faq route upserts one item", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "PUT",
    url: "/faq/FAQ-1",
    headers: { authorization: "Bearer retrieval-dev" },
    payload: { question: "Q", answer: "A" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { upserted: 1, skipped: 0, deleted: 0 });
});

test("faq route deletes one item", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "DELETE",
    url: "/faq/FAQ-1",
    headers: { authorization: "Bearer retrieval-dev" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { deleted: 1 });
});

test("faq route accepts bulk operations", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "POST",
    url: "/faq/bulk",
    headers: { authorization: "Bearer retrieval-dev" },
    payload: {
      items: [
        { op: "upsert", id: "FAQ-1", question: "Q", answer: "A" },
        { op: "delete", id: "FAQ-2" },
      ],
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    processed: 2,
    upserted: 1,
    skipped: 0,
    deleted: 1,
  });
});

test("faq route accepts async reindex payload", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "POST",
    url: "/faq/reindex",
    headers: { authorization: "Bearer retrieval-dev" },
    payload: { items: [{ id: "FAQ-1", question: "Q", answer: "A" }] },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "accepted" });
});

test("faq route returns singleton reindex status", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "GET",
    url: "/faq/reindex/status",
    headers: { authorization: "Bearer retrieval-dev" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "completed",
    started_at: "2026-07-03T00:00:00.000Z",
    finished_at: "2026-07-03T00:00:01.000Z",
    processed: 1,
    total: 1,
    upserted: 1,
    skipped: 0,
    deleted: 0,
  });
});

test("faq parameterized reindex status route is absent", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "GET",
    url: "/faq/reindex/status/faq-reindex-test",
    headers: { authorization: "Bearer retrieval-dev" },
  });
  assert.equal(response.statusCode, 404);
});
