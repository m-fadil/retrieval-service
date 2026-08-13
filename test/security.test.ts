import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { createFaqService, FAQ_SOURCE } from "../src/services/faq.js";
import { ACTOR_HEADER } from "../src/services/frappe.js";
import { createFrappeMcpClient } from "../src/services/mcp.js";
import { createRagService } from "../src/services/rag.js";
import type { Embedder } from "../src/services/embeddings.js";
import type { FaqService } from "../src/services/faq.js";
import type { RagService } from "../src/services/rag.js";
import type { VectorStore } from "../src/services/qdrant.js";

const config: AppConfig = {
  PORT: 3000,
  HOST: "127.0.0.1",
  QDRANT_URL: "http://qdrant:6333",
  QDRANT_COLLECTION: "knowledge_base",
  FRAPPE_URL: "http://localhost:8000",
  FRAPPE_AUTH_TOKEN: "token dev",
  RETRIEVAL_API_KEY: "retrieval-dev",
  OPENAI_API_URL: "https://llm.example.test",
  OPENAI_API_KEY: "sk-dev",
  OPENAI_MODEL: "large",
  EMBEDDING_API_URL: "https://embed.example.test",
  EMBEDDING_API_KEY: "embed-dev",
  EMBEDDING_MODEL: "text-embedding-3-small",
  LOG_CHAT_REQUEST_BODY: false,
  LOG_LEVEL: "silent",
  LLM_TIMEOUT_MS: 60_000,
  LLM_MAX_RETRIES: 0,
  EMBEDDING_TIMEOUT_MS: 30_000,
  FRAPPE_TIMEOUT_MS: 30_000,
  QDRANT_TIMEOUT_MS: 10_000,
  MAX_BODY_BYTES: 1_048_576,
  RATE_LIMIT_MAX: 100_000,
  FAQ_RATE_LIMIT_MAX: 100_000,
  RATE_LIMIT_WINDOW_MS: 60_000,
  TRUST_PROXY: false,
  CHAT_DEADLINE_MS: 120_000,
  EMBEDDING_MAX_RETRIES: 0,
  EMBEDDING_BATCH_SIZE: 64,
  CHAT_ASYNC_MAX_CONCURRENT: 8,
  CHAT_ASYNC_MAX_QUEUED: 64,
  LLM_NATIVE_TOOLS: "auto",
  LLM_JSON_SCHEMA: "auto",
  MCP_MAX_TOOL_PAGES: 20,
  ASSISTANT_SCOPE: "",
};

const authHeaders = { authorization: `Bearer ${config.RETRIEVAL_API_KEY}` };

const embedder: Embedder = {
  async embed() {
    return [1];
  },
};

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

const rag: RagService = {
  async index() {
    return { indexed: 1 };
  },
  async search() {
    return { matches: [] };
  },
  async answer() {
    return { answer: "a", needs_admin: false, reason: "r", sources: [] };
  },
  async query() {
    return { answer: "a", needs_admin: false, reason: "r", sources: [] };
  },
  async chat() {
    return {
      answer: "a",
      route: "faq",
      needs_admin: false,
      reason: "r",
      tools_used: [],
      sources: [],
    };
  },
  async generateFaq() {
    return { question: "q", answer: "a", is_useful: true };
  },
};

const faq: FaqService = {
  async upsert() {
    return { upserted: 1, skipped: 0, deleted: 0 };
  },
  async delete() {
    return { deleted: 1 };
  },
  async bulk() {
    return { processed: 1, upserted: 1, skipped: 0, deleted: 0 };
  },
  async reindex() {
    return { status: "accepted" };
  },
  async recreate() {
    return { status: "accepted" };
  },
  async reindexStatus() {
    return { status: "not_started" };
  },
};

type Method = "GET" | "POST" | "PUT" | "DELETE";

const PROTECTED: Array<[Method, string, Record<string, unknown> | undefined]> =
  [
    ["POST", "/chat", { message: "hi" }],
    ["POST", "/search", { question: "hi" }],
    ["POST", "/answer", { question: "hi" }],
    ["POST", "/query", { question: "hi" }],
    ["POST", "/index", { documents: [{ id: "1", text: "x" }] }],
    ["POST", "/faq/bulk", { items: [{ op: "delete", id: "x" }] }],
    ["POST", "/faq/reindex", { items: [] }],
    ["POST", "/faq/recreate", { items: [] }],
    ["GET", "/faq/reindex/status", undefined],
    ["PUT", "/faq/FAQ-1", { question: "Q", answer: "A" }],
    ["DELETE", "/faq/FAQ-1", undefined],
  ];

test("every non-health route rejects an unauthenticated caller", async () => {
  const app = buildApp({ config, store, rag, faq, embedder });
  for (const [method, url, payload] of PROTECTED) {
    const response = await app.inject({ method, url, payload });
    assert.equal(
      response.statusCode,
      401,
      `${method} ${url} must require the API key`,
    );
  }
  await app.close();
});

test("every non-health route rejects a wrong API key", async () => {
  const app = buildApp({ config, store, rag, faq, embedder });
  for (const [method, url, payload] of PROTECTED) {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: "Bearer wrong-key" },
      payload,
    });
    assert.equal(
      response.statusCode,
      401,
      `${method} ${url} accepted a bad key`,
    );
  }
  await app.close();
});

test("health stays reachable without credentials", async () => {
  const app = buildApp({ config, store, rag, faq, embedder });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  await app.close();
});

test("rate limiter returns 429 once the window budget is spent", async () => {
  const app = buildApp({
    config: { ...config, RATE_LIMIT_MAX: 3 },
    store,
    rag,
    faq,
    embedder,
  });
  const call = () =>
    app.inject({
      method: "POST",
      url: "/chat",
      headers: authHeaders,
      payload: { message: "hi" },
    });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await call()).statusCode, 200);
  }
  const limited = await call();
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers["retry-after"]);
  await app.close();
});

test("oversized bodies are refused before reaching a paid code path", async () => {
  const app = buildApp({
    config: { ...config, MAX_BODY_BYTES: 512 },
    store,
    rag: {
      ...rag,
      async chat() {
        assert.fail("chat must not run for an oversized body");
      },
    },
    faq,
    embedder,
  });
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: authHeaders,
    payload: { message: "x".repeat(4096) },
  });
  assert.equal(response.statusCode, 413);
  await app.close();
});

test("actor identity reaches Frappe as a header, never as a tool argument", async () => {
  const calls: Array<{ actor?: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body));
    calls.push({ actor: headers[ACTOR_HEADER], body });
    const result =
      body.method === "tools/list"
        ? {
            tools: [
              {
                name: "get_staff_job_context",
                inputSchema: {
                  type: "object",
                  properties: { staff_id: {} },
                  required: ["staff_id"],
                },
              },
            ],
          }
        : { content: [{ type: "text", text: "schedule data" }] };
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const mcp = createFrappeMcpClient(config);
    await mcp.callTool(
      "staff",
      "get_staff_job_context",
      { staff_id: "STAFF-1" },
      undefined,
      "trainer@example.test",
    );

    assert.ok(calls.length >= 1);
    for (const call of calls) {
      assert.equal(
        call.actor,
        "trainer@example.test",
        "actor must travel in the header on every MCP hop",
      );
    }
    const toolCall = calls.find((c) => c.body.method === "tools/call");
    assert.ok(toolCall);
    const args = (
      toolCall.body.params as { arguments: Record<string, unknown> }
    ).arguments;
    assert.ok(
      !("actor" in args),
      "actor must not be injected into tool arguments where a prompt could reach it",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FAQ retrieval is scoped to FAQ points only", async () => {
  const seen: Array<{ source?: string }> = [];
  const scopedStore: VectorStore = {
    ...store,
    async search(_vector, _limit, options) {
      seen.push({ source: options?.source });
      return [];
    },
  };
  const service = createRagService(config, embedder, scopedStore, {
    async listTools() {
      return [];
    },
    async callTool() {
      throw new Error("not expected");
    },
  });
  await service.chat({
    question: "membership price",
    limit: 3,
    min_score: 0.7,
    type: "staff",
  });
  assert.ok(seen.length >= 1);
  assert.equal(seen[0]?.source, FAQ_SOURCE);
});

test("reindex writes the new generation before retiring stale points", async () => {
  const order: string[] = [];
  let keep: string[] = [];
  const trackingStore: VectorStore = {
    ...store,
    async upsert(points) {
      // One call per batch, so the whole batch's ids are recorded together.
      order.push(`upsert:${points.map((point) => point.id).join(",")}`);
    },
    async countBySourceExcept() {
      return 2;
    },
    async deleteBySourceExcept(_source, keepIds) {
      order.push("delete-stale");
      keep = keepIds;
    },
    async deleteBySource() {
      order.push("delete-all");
    },
  };
  const service = createFaqService(embedder, trackingStore);

  await service.reindex({
    items: [
      { id: "A", question: "q1", answer: "a1", enabled: true },
      { id: "B", question: "q2", answer: "a2", enabled: true },
    ],
  });
  // reindex is fire-and-forget, so wait for it to settle.
  for (let i = 0; i < 50; i += 1) {
    if ((await service.reindexStatus()).status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.deepEqual(order, ["upsert:frappe_faq:A,frappe_faq:B", "delete-stale"]);
  assert.ok(
    !order.includes("delete-all"),
    "reindex must never blank the index up front",
  );
  assert.deepEqual(keep, ["frappe_faq:A", "frappe_faq:B"]);

  const status = await service.reindexStatus();
  assert.equal(status.status, "completed");
  assert.equal(status.status === "completed" && status.deleted, 2);
});

test("faq generation returns a validated draft and is auth-guarded", async () => {
  const replies = [
    '```json\n{"question":"How do I freeze my membership?","answer":"Open Membership and choose Freeze.","is_useful":true}\n```',
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: replies.shift() } }],
        usage: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const service = createRagService(config, embedder, store, {
      async listTools() {
        return [];
      },
      async callTool() {
        throw new Error("not expected");
      },
    });
    const app = buildApp({ config, store, rag: service, faq, embedder });

    // Unauthenticated callers must not reach a paid LLM call.
    const denied = await app.inject({
      method: "POST",
      url: "/faq/generate",
      payload: { messages: [{ sender_type: "User", message: "hi" }] },
    });
    assert.equal(denied.statusCode, 401);

    const response = await app.inject({
      method: "POST",
      url: "/faq/generate",
      headers: authHeaders,
      payload: {
        messages: [
          { sender_type: "User", message: "How do I freeze my membership?" },
          {
            sender_type: "Admin",
            message: "Open Membership and choose Freeze.",
          },
        ],
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      question: "How do I freeze my membership?",
      answer: "Open Membership and choose Freeze.",
      is_useful: true,
    });
    await app.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("faq generation rejects a reply that does not match the draft shape", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "I could not find a question." } }],
        usage: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const service = createRagService(config, embedder, store, {
      async listTools() {
        return [];
      },
      async callTool() {
        throw new Error("not expected");
      },
    });
    await assert.rejects(() =>
      service.generateFaq({
        messages: [{ sender_type: "User", message: "hi" }],
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
