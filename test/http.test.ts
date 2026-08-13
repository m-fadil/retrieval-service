/**
 * The request lifecycle around the handlers: schema validation, the rate-limit
 * bucket, the health probes, and the background-job backlog.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.js";
import type { ChatDispatcher } from "../src/services/dispatch.js";
import type { VectorStore } from "../src/services/qdrant.js";
import { authHeaders, config, embedder, faq, rag, store } from "./fixtures.js";

const invalidBodies: Array<[string, string, Record<string, unknown>]> = [
  ["POST", "/chat", {}],
  ["POST", "/chat", { message: "hi", history: [{ role: "system" }] }],
  ["POST", "/chat/async", { message: "hi", session_id: "CHAT-1" }],
  ["POST", "/search", { question: "" }],
  ["POST", "/answer", { limit: 999 }],
  ["POST", "/index", { documents: [] }],
  ["POST", "/faq/bulk", { items: [{ op: "sideways", id: "x" }] }],
  ["PUT", "/faq/FAQ-1", { question: "Q" }],
];

test("a malformed body is a 400 naming the offending field", async () => {
  const app = buildApp({ config, store, rag, faq, embedder });
  for (const [method, url, payload] of invalidBodies) {
    const response = await app.inject({
      method: method as "POST",
      url,
      headers: authHeaders,
      payload,
    });
    // Outside Fastify's pipeline these are 500s: the ZodError escapes the
    // handler as an unhandled server error.
    assert.equal(response.statusCode, 400, `${method} ${url}`);
    const body = response.json() as { message: string; issues: unknown[] };
    assert.match(body.message, /failed validation/);
    assert.ok(Array.isArray(body.issues) && body.issues.length > 0);
  }
  await app.close();
});

test("a validation failure never reaches a paid code path", async () => {
  const app = buildApp({
    config,
    store,
    rag: {
      ...rag,
      async chat() {
        assert.fail("chat must not run for an invalid body");
      },
    },
    faq,
    embedder,
  });
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: authHeaders,
    payload: { limit: 3 },
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test("a model reply that fails validation is a 500, not the caller's fault", async () => {
  const app = buildApp({
    config,
    store,
    rag: {
      ...rag,
      async generateFaq() {
        // What the FAQ generator throws on an off-shape model reply.
        throw new Error("LLM reply did not match the FAQ draft shape: bad");
      },
    },
    faq,
    embedder,
  });
  const response = await app.inject({
    method: "POST",
    url: "/faq/generate",
    headers: authHeaders,
    payload: { messages: [{ sender_type: "User", message: "hi" }] },
  });
  assert.equal(response.statusCode, 500);
  // Upstream detail belongs in the log, not the response body.
  assert.equal(response.json().message, "Internal Server Error");
  await app.close();
});

test("readiness fails while Qdrant is unreachable, liveness does not", async () => {
  const downStore: VectorStore = {
    ...store,
    async health() {
      return false;
    },
  };
  const app = buildApp({ config, store: downStore, rag, faq, embedder });

  const live = await app.inject({ method: "GET", url: "/health/live" });
  assert.equal(live.statusCode, 200);

  const ready = await app.inject({ method: "GET", url: "/health/ready" });
  // A replica that cannot reach Qdrant answers every question with "no match",
  // so it must report that to whatever routes traffic to it.
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.json(), { ok: false, qdrant: false });

  // Shape held fixed for the container healthcheck and Frappe, which call it.
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  await app.close();
});

test("readiness returns 200 once Qdrant answers", async () => {
  const app = buildApp({ config, store, rag, faq, embedder });
  const ready = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { ok: true, qdrant: true });
  await app.close();
});

test("the rate-limit bucket is the end user, not the source address", async () => {
  const app = buildApp({
    config: { ...config, RATE_LIMIT_MAX: 2 },
    store,
    rag,
    faq,
    embedder,
  });
  const call = (actor: string) =>
    app.inject({
      method: "POST",
      url: "/chat",
      headers: authHeaders,
      payload: { message: "hi", actor },
    });

  assert.equal((await call("a@example.test")).statusCode, 200);
  assert.equal((await call("a@example.test")).statusCode, 200);
  const limited = await call("a@example.test");
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers["retry-after"]);
  // All chat traffic originates from one Frappe server, so an address bucket
  // spends this member's budget on the previous member's questions.
  assert.equal((await call("b@example.test")).statusCode, 200);
  await app.close();
});

test("FAQ sync spends its own budget, not the end users'", async () => {
  const app = buildApp({
    config: { ...config, RATE_LIMIT_MAX: 1, FAQ_RATE_LIMIT_MAX: 3 },
    store,
    rag,
    faq,
    embedder,
  });
  const sync = () =>
    app.inject({
      method: "PUT",
      url: "/faq/FAQ-1",
      headers: authHeaders,
      payload: { question: "Q", answer: "A" },
    });
  const ask = () =>
    app.inject({
      method: "POST",
      url: "/chat",
      headers: authHeaders,
      payload: { message: "hi", actor: "a@example.test" },
    });

  // A bulk FAQ import issues one write per row and carries no actor, so on the
  // shared address bucket it exceeds a single member's budget and fails
  // doc_events mid-run.
  assert.equal((await sync()).statusCode, 200);
  assert.equal((await sync()).statusCode, 200);
  assert.equal((await sync()).statusCode, 200);
  assert.equal((await sync()).statusCode, 429);

  // Spending the FAQ budget must leave the chat budget intact.
  assert.equal((await ask()).statusCode, 200);
  assert.equal((await ask()).statusCode, 429);
  await app.close();
});

test("faq generation stays on the ordinary budget", async () => {
  const app = buildApp({
    config: { ...config, RATE_LIMIT_MAX: 1, FAQ_RATE_LIMIT_MAX: 100 },
    store,
    rag,
    faq,
    embedder,
  });
  const generate = () =>
    app.inject({
      method: "POST",
      url: "/faq/generate",
      headers: authHeaders,
      payload: { messages: [{ sender_type: "User", message: "hi" }] },
    });

  // Costs an LLM call per request and is user-initiated, so it is not sync
  // traffic despite the path prefix.
  assert.equal((await generate()).statusCode, 200);
  assert.equal((await generate()).statusCode, 429);
  await app.close();
});

test("health probes are exempt from the rate limit", async () => {
  const app = buildApp({
    config: { ...config, RATE_LIMIT_MAX: 1 },
    store,
    rag,
    faq,
    embedder,
  });
  for (const url of ["/health", "/health/live", "/health/ready"]) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 200, url);
    }
  }
  await app.close();
});

function backlogDispatcher(accepts: boolean): ChatDispatcher & {
  drained: number;
  dispatched: number;
} {
  const state = { drained: 0, dispatched: 0 };
  return {
    ...state,
    accepts: () => accepts,
    pending: () => 1,
    async drain() {
      this.drained += 1;
    },
    async dispatch() {
      this.dispatched += 1;
    },
  };
}

test("a full backlog is refused with 503 while the caller is listening", async () => {
  const dispatcher = backlogDispatcher(false);
  const app = buildApp({ config, store, rag, faq, embedder, dispatcher });
  const response = await app.inject({
    method: "POST",
    url: "/chat/async",
    headers: authHeaders,
    payload: { message: "hi", request_id: "req-1", session_id: "CHAT-1" },
  });
  // A 202 for a dropped job leaves the member awaiting an answer that never
  // arrives.
  assert.equal(response.statusCode, 503);
  assert.equal(dispatcher.dispatched, 0);
  await app.close();
});

test("shutdown drains accepted background jobs", async () => {
  const dispatcher = backlogDispatcher(true);
  const app = buildApp({ config, store, rag, faq, embedder, dispatcher });
  const response = await app.inject({
    method: "POST",
    url: "/chat/async",
    headers: authHeaders,
    payload: { message: "hi", request_id: "req-1", session_id: "CHAT-1" },
  });
  assert.equal(response.statusCode, 202);
  assert.equal(dispatcher.dispatched, 1);

  // Without the onClose drain, a rolling deploy discards jobs whose LLM calls
  // are already billed.
  await app.close();
  assert.equal(dispatcher.drained, 1);
});
