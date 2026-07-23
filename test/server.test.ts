import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import {
  createRagService,
  type ChatLog,
  type RagService,
} from "../src/services/rag.js";
import type { Embedder } from "../src/services/embeddings.js";
import type { FaqService } from "../src/services/faq.js";
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
  LOG_LEVEL: "info",
  LLM_TIMEOUT_MS: 60_000,
  LLM_MAX_RETRIES: 0,
  EMBEDDING_TIMEOUT_MS: 30_000,
  FRAPPE_TIMEOUT_MS: 30_000,
  QDRANT_TIMEOUT_MS: 10_000,
  MAX_BODY_BYTES: 1_048_576,
  // High enough that the shared app fixture is never rate limited mid-suite.
  RATE_LIMIT_MAX: 100_000,
  RATE_LIMIT_WINDOW_MS: 60_000,
};

/** Every route except /health now requires the shared API key. */
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

const faqStore: VectorStore = {
  ...store,
  async search() {
    return [{ id: "faq", score: 0.9, payload: { text: "FAQ context" } }];
  },
};

const rag: RagService = {
  async index(input) {
    return { indexed: input.documents.length };
  },
  async search(input) {
    const sources = [
      { id: "hit-1", score: 0.85, payload: { text: input.question } },
      { id: "hit-2", score: 0.51, payload: { text: "unrelated" } },
    ];
    return {
      matches: sources.filter((hit) => hit.score >= input.min_score),
    };
  },
  async answer(
    input,
  ): Promise<
    import("../src/schemas/query.js").ChatResponse<
      import("../src/services/qdrant.js").SearchHit
    >
  > {
    return {
      answer: `answer:${input.question}`,
      route: "hybrid",
      needs_admin: false,
      reason: "tool_match",
      sources: [],
    };
  },
  async query(
    input,
  ): Promise<
    import("../src/schemas/query.js").ChatResponse<
      import("../src/services/qdrant.js").SearchHit
    >
  > {
    return {
      answer: `answer:${input.question}`,
      route: "hybrid",
      needs_admin: false,
      reason: "tool_match",
      sources: [],
    };
  },
  async chat(
    input,
  ): Promise<
    import("../src/schemas/query.js").ChatResponse<
      import("../src/services/qdrant.js").SearchHit
    >
  > {
    const sources = [
      { id: "hit-1", score: 0.85, payload: { text: input.question } },
      { id: "hit-2", score: 0.51, payload: { text: "unrelated" } },
    ].filter((hit) => hit.score >= input.min_score);
    return sources.length
      ? {
          answer: `chat:${input.question}`,
          route: "faq",
          needs_admin: false,
          reason: "faq_match",
          tools_used: ["faq_search"],
          sources,
        }
      : {
          answer:
            "Your question is being forwarded to the admin. Please wait a moment.",
          route: "fallback",
          needs_admin: true,
          reason: "no_faq_match",
          tools_used: ["faq_search"],
          sources,
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
  async bulk(input) {
    return {
      processed: input.items.length,
      upserted: 1,
      skipped: 0,
      deleted: 1,
    };
  },
  async reindex() {
    return { status: "accepted" };
  },
  async recreate() {
    return { status: "accepted" };
  },
  async reindexStatus() {
    return {
      status: "completed",
      started_at: "2026-07-03T00:00:00.000Z",
      finished_at: "2026-07-03T00:00:01.000Z",
      processed: 1,
      total: 1,
      upserted: 1,
      skipped: 0,
      deleted: 0,
    };
  },
};

type McpRequest = {
  id: number;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

type ChatRequestBody = {
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string;
};

type ChatResponseMessage = Record<string, unknown>;

async function withMockMcp<T>(
  responses: ChatResponseMessage[],
  run: (calls: McpRequest[], chatRequests: ChatRequestBody[]) => Promise<T>,
) {
  const originalFetch = globalThis.fetch;
  const calls: McpRequest[] = [];
  const chatRequests: ChatRequestBody[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "https://llm.example.test/v1/chat/completions") {
      assert.equal(init?.method, "POST");
      if (typeof init?.body !== "string") throw new Error("expected JSON body");
      const request = JSON.parse(init.body) as ChatRequestBody;
      chatRequests.push(request);
      const message = responses.shift();
      if (!message) throw new Error("unexpected LLM request");
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert.match(
      String(input),
      /^http:\/\/localhost:8000\/api\/method\/alpha_fitness\.mcp\.handle_(staff|manager)_mcp$/,
    );
    assert.equal(init?.method, "POST");
    const headers = init?.headers;
    const authorization =
      headers instanceof Headers
        ? headers.get("authorization")
        : Array.isArray(headers)
          ? headers.find(([key]) => key.toLowerCase() === "authorization")?.[1]
          : headers?.authorization;
    assert.equal(authorization, "token dev");
    if (typeof init?.body !== "string") throw new Error("expected JSON body");
    const body = JSON.parse(init.body) as McpRequest;
    calls.push(body);
    const result =
      body.method === "tools/list"
        ? {
            tools: [
              {
                name: "get_environment_context",
                inputSchema: {
                  required: ["job_id"],
                  properties: { job_id: {}, question: {} },
                },
              },
              {
                name: "get_job_context",
                inputSchema: {
                  required: ["job_id"],
                  properties: {
                    job_id: {},
                    include_schedules: {},
                    question: {},
                  },
                },
              },
              {
                name: "get_job_team_list",
                inputSchema: {
                  required: ["job_id"],
                  properties: { job_id: {}, question: {} },
                },
              },
              {
                name: "get_job_staff_schedules",
                inputSchema: {
                  required: ["job_id"],
                  properties: { job_id: {}, staff_ids: {}, question: {} },
                },
              },
              {
                name: "get_staff_job_context",
                inputSchema: {
                  required: ["staff_id"],
                  properties: { staff_id: {}, time_filter: {}, question: {} },
                },
              },
              {
                name: "get_staff_upcoming_schedules",
                inputSchema: {
                  required: ["staff_id"],
                  properties: { staff_id: {}, time_filter: {}, question: {} },
                },
              },
            ],
          }
        : {
            content: [
              { type: "text", text: `mcp:${body.params?.name ?? "unknown"}` },
            ],
          };
    return new Response(
      JSON.stringify({ message: { jsonrpc: "2.0", id: body.id, result } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) satisfies typeof fetch;
  try {
    return await run(calls, chatRequests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const plannerCall = (name: string, arguments_: Record<string, unknown>) => ({
  role: "assistant",
  content: JSON.stringify({ calls: [{ name, arguments: arguments_ }] }),
});

const finalAnswer = (content: string) => ({ role: "assistant", content });

const nativeToolCall = (
  name: string,
  arguments_: Record<string, unknown>,
  id = `call_${name}`,
) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(arguments_) },
    },
  ],
});

const nativeToolResponses = (
  name: string,
  arguments_: Record<string, unknown>,
  answer: string,
) => [nativeToolCall(name, arguments_), finalAnswer(answer)];

function assertNativeToolFlow(
  requests: ChatRequestBody[],
  expectedTool: string,
) {
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.tool_choice, "auto");
  assert.match(
    JSON.stringify(requests[0]?.tools),
    new RegExp(`"name":"${expectedTool}"`),
  );
  const assistant = requests[1]?.messages[2];
  assert.equal(assistant?.role, "assistant");
  const toolCalls = assistant?.tool_calls as Array<Record<string, unknown>>;
  assert.equal(toolCalls[0]?.id, `call_${expectedTool}`);
  assert.equal(toolCalls[0]?.type, "function");
  assert.deepEqual(requests[1]?.messages[3], {
    role: "tool",
    tool_call_id: `call_${expectedTool}`,
    content: `mcp:${expectedTool}`,
  });
}

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
    payload: { question: "hello", min_score: 0.5 },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    matches: [
      { id: "hit-1", score: 0.85, payload: { text: "hello" } },
      { id: "hit-2", score: 0.51, payload: { text: "unrelated" } },
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
    dispatcher: {
      async dispatch(input, envelope) {
        dispatched.push({
          question: input.question,
          actor: input.actor,
          envelope,
        });
      },
    },
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
    dispatcher: {
      async dispatch() {
        dispatched += 1;
      },
    },
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

test("chat route accepts message and returns a final answer", async () => {
  const app = buildApp({ config, store, rag, faq });
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: authHeaders,
    payload: { message: "hello" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    answer: "chat:hello",
    route: "faq",
    needs_admin: false,
    reason: "faq_match",
    tools_used: ["faq_search"],
    sources: [{ id: "hit-1", score: 0.85, payload: { text: "hello" } }],
  });
});

test("chat route uses faq_search for general FAQ even with job_id and staff_id", async () => {
  await withMockMcp([finalAnswer("unused")], async (_calls, requests) => {
    const chatStore: VectorStore = {
      ...store,
      async search() {
        return [
          {
            id: "faq-alpha",
            score: 0.9,
            payload: { answer: "Alpha Fitness is a wellness club." },
          },
        ];
      },
    };
    const service = createRagService(config, embedder, chatStore, {
      async listTools() {
        return [];
      },
      async callTool() {
        throw new Error("MCP should not be called");
      },
    });
    const app = buildApp({ config, store, rag: service, faq });
    const response = await app.inject({
      method: "POST",
      url: "/chat",
      headers: authHeaders,
      payload: {
        message: "What is Alpha Fitness",
        job_id: "JOB-1",
        staff_id: "STAFF-1",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.stringify(requests[0]).includes("tool_choice"), false);
    assert.deepEqual(response.json(), {
      answer: "Alpha Fitness is a wellness club.",
      route: "faq",
      needs_admin: false,
      reason: "faq_match",
      tools_used: ["faq_search"],
      sources: [
        {
          id: "faq-alpha",
          score: 0.9,
          payload: { answer: "Alpha Fitness is a wellness club." },
        },
      ],
    });
  });
});

test("chat route keeps FAQ answer when MCP tool discovery fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://llm.example.test/v1/chat/completions");
    assert.equal(init?.method, "POST");
    return new Response(
      JSON.stringify({ choices: [{ message: finalAnswer("unused") }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) satisfies typeof fetch;
  try {
    const chatStore: VectorStore = {
      ...store,
      async search() {
        return [
          {
            id: "faq-alpha",
            score: 0.9,
            payload: { answer: "Alpha Fitness is a wellness club." },
          },
        ];
      },
    };
    const service = createRagService(config, embedder, chatStore, {
      async listTools() {
        throw new Error(
          "Frappe alpha_fitness.mcp.handle_mcp failed: 417 EXPECTATION FAILED",
        );
      },
      async callTool() {
        assert.fail("MCP callTool must not be invoked");
      },
    });
    const app = buildApp({ config, store, rag: service, faq });
    const response = await app.inject({
      method: "POST",
      url: "/chat",
      headers: authHeaders,
      payload: { message: "What is Alpha Fitness", job_id: "JOB-1" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      answer: "Alpha Fitness is a wellness club.",
      route: "faq",
      needs_admin: false,
      reason: "faq_match",
      tools_used: ["faq_search"],
      sources: [
        {
          id: "faq-alpha",
          score: 0.9,
          payload: { answer: "Alpha Fitness is a wellness club." },
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat logs sanitized debug metadata when MCP tool discovery degrades with 417", async () => {
  const secretToken = "token frappe-secret-token";
  const question = "sensitive customer question";
  const jobId = "JOB-sensitive";
  const rawBody = "raw-error-response-sensitive";
  const events: Array<{ level: string; value: unknown }> = [];
  const log: ChatLog = {
    debug(value: unknown) {
      events.push({ level: "debug", value });
    },
    info() {},
    error() {},
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: finalAnswer("unused") }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) satisfies typeof fetch;
  try {
    const service = createRagService(
      { ...config, FRAPPE_AUTH_TOKEN: secretToken },
      embedder,
      faqStore,
      {
        async listTools() {
          throw new Error(
            `Frappe tools/list failed: 417 ${rawBody} ${secretToken} ${question} ${jobId}`,
          );
        },
        async callTool() {
          assert.fail("MCP callTool must not be invoked");
        },
      },
    );

    await service.chat(
      { type: "staff", question, limit: 5, min_score: 0.7, job_id: jobId },
      log,
    );

    const debugEvents = events.filter((event) => event.level === "debug");
    assert.equal(debugEvents.length, 1);
    const output = JSON.stringify(debugEvents[0]?.value);
    assert.match(output, /operation.*tools\/list/);
    assert.match(output, /status.*417/);
    assert.equal(output.includes(secretToken), false);
    assert.equal(output.includes(question), false);
    assert.equal(output.includes(jobId), false);
    assert.equal(output.includes(rawBody), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat emits sanitized native LLM usage and MCP lifecycle info", async () => {
  const question = "sensitive customer question";
  const arguments_ = {
    question,
    job_id: "JOB-sensitive",
    secret: "sensitive arguments",
  };
  const toolResult = "sensitive tool result";
  const events: Array<{ level: string; value: unknown }> = [];
  const log: ChatLog = {
    debug() {},
    info(value: unknown) {
      events.push({ level: "info", value });
    },
    error() {},
  };
  const originalFetch = globalThis.fetch;
  const responses = [
    nativeToolCall("get_job_context", arguments_),
    finalAnswer("safe answer"),
  ];
  globalThis.fetch = (async () => {
    const message = responses.shift();
    if (!message) throw new Error("unexpected LLM request");
    return new Response(
      JSON.stringify({
        choices: [{ message }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) satisfies typeof fetch;
  try {
    const service = createRagService(config, embedder, store, {
      async listTools() {
        return [
          {
            name: "get_environment_context",
            inputSchema: {
              required: ["job_id"],
              properties: { job_id: {}, question: {} },
            },
          },
          {
            name: "get_job_context",
            inputSchema: {
              required: ["job_id"],
              properties: { job_id: {}, question: {}, secret: {} },
            },
          },
        ];
      },
      async callTool(_type, name) {
        return { content: [{ type: "text", text: `${name}: ${toolResult}` }] };
      },
    });

    await service.chat(
      {
        type: "staff",
        question,
        limit: 5,
        min_score: 0.7,
        job_id: "JOB-sensitive",
      },
      log,
    );

    const info = events
      .filter((event) => event.level === "info")
      .map((event) => event.value as Record<string, unknown>);
    for (const stage of [
      "chat.native_tool_selection",
      "chat.native_tool_replay",
    ]) {
      assert.ok(
        info.some(
          (event) =>
            event.stage === stage &&
            event.usage_available === true &&
            event.prompt_tokens === 11 &&
            event.completion_tokens === 7 &&
            event.total_tokens === 18,
        ),
      );
    }
    for (const [tool, mode] of [
      ["get_environment_context", "mandatory"],
      ["get_job_context", "native"],
    ]) {
      assert.ok(
        info.some(
          (event) =>
            event.tool === tool &&
            event.mode === mode &&
            event.status === "started",
        ),
      );
      assert.ok(
        info.some(
          (event) =>
            event.tool === tool &&
            event.mode === mode &&
            event.status === "completed" &&
            typeof event.ms === "number",
        ),
      );
    }
    const output = JSON.stringify(info);
    assert.equal(output.includes(question), false);
    assert.equal(output.includes(JSON.stringify(arguments_)), false);
    assert.equal(output.includes(toolResult), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat logs unavailable LLM usage for planner flow without request data", async () => {
  const question = "sensitive planner question";
  const toolResult = "sensitive planner result";
  const events: Array<{ level: string; value: unknown }> = [];
  const log: ChatLog = {
    debug() {},
    info(value: unknown) {
      events.push({ level: "info", value });
    },
    error() {},
  };
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  await withPlanner(
    [nativeNoCalls(), plannerCall("staff", {}), finalAnswer("safe answer")],
    async () => {
      const service = createRagService(config, embedder, store, {
        async listTools() {
          return [staffTool("staff")];
        },
        async callTool(_type, name, toolArguments) {
          calls.push({ name, arguments: toolArguments });
          return { content: [{ type: "text", text: toolResult }] };
        },
      });
      await service.chat(
        {
          type: "staff",
          question,
          limit: 5,
          min_score: 0.7,
          staff_id: "STAFF-sensitive",
        },
        log,
      );
    },
  );

  const info = events
    .filter((event) => event.level === "info")
    .map((event) => event.value as Record<string, unknown>);
  assert.ok(
    info.some(
      (event) =>
        event.stage === "chat.native_tool_selection" &&
        event.usage_available === false,
    ),
  );
  assert.ok(
    info.some(
      (event) => event.stage === "chat.plan" && event.usage_available === false,
    ),
  );
  assert.ok(
    info.some(
      (event) =>
        event.stage === "chat.compose_answer" &&
        event.usage_available === false,
    ),
  );
  assert.ok(
    info.some(
      (event) =>
        event.tool === "staff" &&
        event.mode === "planner" &&
        event.status === "started",
    ),
  );
  assert.ok(
    info.some(
      (event) =>
        event.tool === "staff" &&
        event.mode === "planner" &&
        event.status === "completed" &&
        typeof event.ms === "number",
    ),
  );
  const output = JSON.stringify(info);
  assert.equal(output.includes(question), false);
  assert.equal(output.includes(JSON.stringify(calls[0]?.arguments)), false);
  assert.equal(output.includes(toolResult), false);
});

test("chat logs a sanitized optional MCP failure lifecycle", async () => {
  const sensitive = "secret-token-and-customer-data";
  const events: Array<{ level: string; value: unknown }> = [];
  const log: ChatLog = {
    debug() {},
    info(value: unknown) {
      events.push({ level: "info", value });
    },
    error() {},
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: nativeToolCall("staff", {}) }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) satisfies typeof fetch;
  try {
    const service = createRagService(config, embedder, store, {
      async listTools() {
        return [staffTool("staff")];
      },
      async callTool() {
        throw new Error(`MCP failed: ${sensitive}`);
      },
    });
    await assert.rejects(
      service.chat(
        {
          type: "staff",
          question: "details",
          limit: 5,
          min_score: 0.7,
          staff_id: "STAFF-1",
        },
        log,
      ),
      new RegExp(sensitive),
    );
    const lifecycle = events
      .filter(({ level, value }) => {
        const event = value as Record<string, unknown>;
        return (
          level === "info" && event.tool === "staff" && event.mode === "native"
        );
      })
      .map(({ value }) => value as Record<string, unknown>);
    assert.deepEqual(
      lifecycle.map((event) => event.status),
      ["started", "error"],
    );
    assert.equal(typeof lifecycle[1]?.ms, "number");
    assert.deepEqual(Object.keys(lifecycle[0] ?? {}).sort(), [
      "mode",
      "status",
      "tool",
    ]);
    assert.deepEqual(Object.keys(lifecycle[1] ?? {}).sort(), [
      "mode",
      "ms",
      "status",
      "tool",
    ]);
    assert.equal(JSON.stringify(lifecycle).includes(sensitive), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat route combines FAQ and native MCP tool calling for schedule intent", async () => {
  await withMockMcp(
    nativeToolResponses(
      "get_job_context",
      { question: "When next schedule", job_id: "JOB-1" },
      "The next schedule is in the app.",
    ),
    async (calls, requests) => {
      const chatStore: VectorStore = {
        ...store,
        async search() {
          return [
            {
              id: "faq-schedule",
              score: 0.91,
              payload: { text: "FAQ says schedules are in the app." },
            },
          ];
        },
      };
      const mcpRag = createRagService(config, embedder, chatStore);
      const app = buildApp({ config, store, rag: mcpRag, faq });
      const response = await app.inject({
        method: "POST",
        url: "/chat",
        headers: authHeaders,
        payload: {
          message: "When next schedule",
          job_id: "JOB-1",
          staff_id: "STAFF-1",
        },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().answer, "The next schedule is in the app.");
      assert.equal(response.json().route, "hybrid");
      assert.equal(response.json().needs_admin, false);
      assert.equal(response.json().reason, "tool_match");
      assert.deepEqual(response.json().tools_used, [
        "faq_search",
        "get_environment_context",
        "get_job_context",
      ]);
      assert.deepEqual(calls[1]?.params, {
        name: "get_environment_context",
        arguments: { question: "When next schedule", job_id: "JOB-1" },
      });
      assert.deepEqual(calls[2]?.params, {
        name: "get_job_context",
        arguments: { question: "When next schedule", job_id: "JOB-1" },
      });
      assertNativeToolFlow(requests, "get_job_context");
      const replayPrompt = JSON.stringify(requests[1]?.messages[0]);
      assert.match(replayPrompt, /FAQ says schedules are in the app\./);
      assert.match(replayPrompt, /mcp:get_environment_context/);
    },
  );
});

test("chat calls get_environment_context before optional MCP tools when job_id exists", async () => {
  await withMockMcp(
    nativeToolResponses(
      "get_job_context",
      { question: "job status", job_id: "JOB-1" },
      "Job status is available.",
    ),
    async (calls) => {
      const mcpRag = createRagService(config, embedder, faqStore);
      const response = await mcpRag.chat({
        type: "staff",
        question: "job status",
        limit: 5,
        min_score: 0.7,
        job_id: "JOB-1",
      });
      assert.equal(response.answer, "Job status is available.");
      assert.equal(response.needs_admin, false);
      assert.equal(response.reason, "tool_match");
      assert.deepEqual(response.tools_used, [
        "faq_search",
        "get_environment_context",
        "get_job_context",
      ]);
      assert.deepEqual(
        calls.map((call) => call.method),
        ["tools/list", "tools/call", "tools/call"],
      );
      assert.deepEqual(calls[1]?.params, {
        name: "get_environment_context",
        arguments: { question: "job status", job_id: "JOB-1" },
      });
      assert.deepEqual(calls[2]?.params, {
        name: "get_job_context",
        arguments: { question: "job status", job_id: "JOB-1" },
      });
    },
  );
});

test("chat does not return raw environment context when it is the only source", async () => {
  const service = createRagService(
    config,
    embedder,
    store,
    {
      async listTools() {
        return [
          {
            name: "get_environment_context",
            inputSchema: {
              required: ["job_id"],
              properties: { job_id: {}, question: {} },
            },
          },
        ];
      },
      async callTool() {
        return {
          structuredContent: {
            day_name: "Thursday",
            timezone: "Asia/Singapore",
          },
        };
      },
    },
    async (question, sources) =>
      `natural:${question}:${String(sources[0]?.payload?.text ?? "")}`,
  );
  assert.deepEqual(
    await service.chat({
      type: "staff",
      question: "How do I cancel cover request",
      limit: 3,
      min_score: 0.7,
      job_id: "JOB-1",
      staff_id: "STAFF-1",
    }),
    {
      answer:
        "Your question is being forwarded to the admin. Please wait a moment.",
      route: "hybrid",
      needs_admin: true,
      reason: "insufficient_context",
      tools_used: ["faq_search", "get_environment_context"],
      sources: [
        {
          id: "get_environment_context",
          payload: {
            text: '{"day_name":"Thursday","timezone":"Asia/Singapore"}',
            source: "mcp",
            tool: "get_environment_context",
          },
        },
      ],
    },
  );
});

test("chat planner ignores reasoning content in OpenAI-compatible responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.equal(String(input), "https://llm.example.test/v1/chat/completions");
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ calls: [] }),
              reasoning_content:
                "Internal model reasoning that must be ignored.",
              role: "assistant",
            },
            finish_reason: "stop",
            index: 0,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) satisfies typeof fetch;
  try {
    const chatStore: VectorStore = {
      ...store,
      async search() {
        return [
          {
            id: "faq-alpha",
            score: 0.9,
            payload: { answer: "Alpha Fitness is a wellness club." },
          },
        ];
      },
    };
    const service = createRagService(config, embedder, chatStore, {
      async listTools() {
        return [];
      },
      async callTool() {
        throw new Error("MCP should not be called");
      },
    });
    assert.deepEqual(
      await service.chat({
        type: "staff",
        question: "What is Alpha Fitness",
        limit: 3,
        min_score: 0.7,
        job_id: "JOB-1",
        staff_id: "STAFF-1",
      }),
      {
        answer: "Alpha Fitness is a wellness club.",
        route: "faq",
        needs_admin: false,
        reason: "faq_match",
        tools_used: ["faq_search"],
        sources: [
          {
            id: "faq-alpha",
            score: 0.9,
            payload: { answer: "Alpha Fitness is a wellness club." },
          },
        ],
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat route maps job_id to get_job_context MCP args", async () => {
  await withMockMcp(
    nativeToolResponses(
      "get_job_context",
      { question: "job status", job_id: "JOB-1", include_schedules: true },
      "Job status is available.",
    ),
    async (calls) => {
      const mcpRag = createRagService(config, embedder, faqStore);
      const app = buildApp({ config, store, rag: mcpRag, faq });
      const response = await app.inject({
        method: "POST",
        url: "/chat",
        headers: authHeaders,
        payload: {
          message: "job status",
          job_id: "JOB-1",
          include_schedules: true,
        },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().answer, "Job status is available.");
      assert.equal(response.json().needs_admin, false);
      assert.equal(response.json().reason, "tool_match");
      assert.deepEqual(response.json().tools_used, [
        "faq_search",
        "get_environment_context",
        "get_job_context",
      ]);
      assert.deepEqual(
        calls.map((call) => call.method),
        ["tools/list", "tools/call", "tools/call"],
      );
      assert.deepEqual(calls[1]?.params, {
        name: "get_environment_context",
        arguments: { question: "job status", job_id: "JOB-1" },
      });
      assert.deepEqual(calls[2]?.params, {
        name: "get_job_context",
        arguments: {
          question: "job status",
          job_id: "JOB-1",
          include_schedules: true,
        },
      });
    },
  );
});

test("chat route maps staff_id to get_staff_job_context MCP args", async () => {
  await withMockMcp(
    nativeToolResponses(
      "get_staff_job_context",
      { question: "staff schedule", staff_id: "STAFF-1", time_filter: "today" },
      "Staff schedule is available.",
    ),
    async (calls) => {
      const mcpRag = createRagService(config, embedder, faqStore);
      const app = buildApp({ config, store, rag: mcpRag, faq });
      const response = await app.inject({
        method: "POST",
        url: "/chat",
        headers: authHeaders,
        payload: {
          message: "staff schedule",
          staff_id: "STAFF-1",
          time_filter: "today",
        },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().answer, "Staff schedule is available.");
      assert.equal(response.json().needs_admin, false);
      assert.equal(response.json().reason, "tool_match");
      assert.deepEqual(
        calls.map((call) => call.method),
        ["tools/list", "tools/call"],
      );
      assert.deepEqual(calls[1]?.params, {
        name: "get_staff_job_context",
        arguments: {
          question: "staff schedule",
          staff_id: "STAFF-1",
          time_filter: "today",
        },
      });
    },
  );
});

test("chat service returns fallback when faq_search has no min_score match", async () => {
  const chatStore: VectorStore = {
    ...store,
    async search() {
      return [{ id: "hit-low", score: 0.51, payload: { answer: "low" } }];
    },
  };
  const service = createRagService(config, embedder, chatStore, {
    async listTools() {
      return [];
    },
    async callTool() {
      throw new Error("MCP should not be called");
    },
  });
  assert.deepEqual(
    await service.chat({
      type: "staff",
      question: "hello",
      limit: 5,
      min_score: 0.7,
    }),
    {
      answer:
        "Your question is being forwarded to the admin. Please wait a moment.",
      route: "fallback",
      needs_admin: true,
      reason: "no_faq_match",
      tools_used: ["faq_search"],
      sources: [],
    },
  );
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

type PlannerMcp = Parameters<typeof createRagService>[3];

const nativeNoCalls = () => ({ role: "assistant", content: null });

async function withPlanner<T>(
  responses: ChatResponseMessage[],
  run: (requests: Array<Record<string, unknown>>) => Promise<T>,
) {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("expected JSON body");
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    const message = responses.shift();
    if (!message) throw new Error("unexpected LLM request");
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) satisfies typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function plannerMcp(
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
  }>,
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
): PlannerMcp {
  return {
    async listTools() {
      return tools;
    },
    async callTool(_type, name, arguments_) {
      calls.push({ name, arguments: arguments_ });
      return { content: [{ type: "text", text: `${name} result` }] };
    },
  };
}

const staffTool = (name: string, description = "Returns staff details") => ({
  name,
  description,
  inputSchema: {
    required: ["staff_id"],
    properties: { staff_id: {}, question: {} },
  },
});

test("planner selects only an advertised historical-capable tool", async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  await withPlanner(
    [
      nativeNoCalls(),
      plannerCall("schedule_history", {}),
      finalAnswer("Past schedules are available."),
    ],
    async (requests) => {
      const service = createRagService(
        config,
        embedder,
        store,
        plannerMcp(
          [staffTool("schedule_history", "Returns historical staff schedules")],
          calls,
        ),
      );
      const response = await service.chat({
        type: "staff",
        question: "show my last few schedules",
        limit: 5,
        min_score: 0.7,
        staff_id: "STAFF-1",
      });
      assert.equal(response.answer, "Past schedules are available.");
      assert.deepEqual(calls, [
        {
          name: "schedule_history",
          arguments: {
            question: "show my last few schedules",
            staff_id: "STAFF-1",
          },
        },
      ]);
      assert.equal(requests[0]?.tool_choice, "auto");
      assert.equal("tools" in requests[1]!, false);
    },
  );
});

test("upcoming-only catalog with empty planner calls falls back", async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  await withPlanner(
    [
      nativeNoCalls(),
      { role: "assistant", content: JSON.stringify({ calls: [] }) },
    ],
    async () => {
      const service = createRagService(
        config,
        embedder,
        store,
        plannerMcp(
          [staffTool("upcoming", "Returns upcoming schedules only")],
          calls,
        ),
      );
      const response = await service.chat({
        type: "staff",
        question: "last schedules",
        limit: 5,
        min_score: 0.7,
        staff_id: "STAFF-1",
      });
      assert.equal(response.route, "fallback");
      assert.deepEqual(calls, []);
    },
  );
});

for (const plan of [
  "not json",
  JSON.stringify({ calls: [{ name: "unknown", arguments: {} }] }),
  JSON.stringify({
    calls: Array.from({ length: 4 }, () => ({ name: "staff", arguments: {} })),
  }),
  JSON.stringify({
    calls: [
      { name: "staff", arguments: {} },
      { name: "staff", arguments: {} },
    ],
  }),
]) {
  test(`invalid planner output executes no optional calls: ${plan.slice(0, 12)}`, async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    await withPlanner(
      [nativeNoCalls(), { role: "assistant", content: plan }],
      async () => {
        const service = createRagService(
          config,
          embedder,
          store,
          plannerMcp([staffTool("staff")], calls),
        );
        const response = await service.chat({
          type: "staff",
          question: "details",
          limit: 5,
          min_score: 0.7,
          staff_id: "STAFF-1",
        });
        assert.equal(response.route, "fallback");
        assert.deepEqual(calls, []);
      },
    );
  });
}

test("FAQ planner may choose no calls", async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const faqOnlyStore: VectorStore = {
    ...store,
    async search() {
      return [{ id: "faq", score: 0.9, payload: { answer: "FAQ answer" } }];
    },
  };
  await withPlanner(
    [
      nativeNoCalls(),
      { role: "assistant", content: JSON.stringify({ calls: [] }) },
    ],
    async () => {
      const response = await createRagService(
        config,
        embedder,
        faqOnlyStore,
        plannerMcp([staffTool("staff")], calls),
      ).chat({ type: "staff", question: "FAQ", limit: 5, min_score: 0.7 });
      assert.equal(response.answer, "FAQ answer");
      assert.deepEqual(calls, []);
    },
  );
});

test("malformed native tool calls fall back to the JSON planner", async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  await withPlanner(
    [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_bad",
            type: "function",
            function: { name: "staff", arguments: "not json" },
          },
        ],
      },
      plannerCall("staff", {}),
      finalAnswer("Planner fallback answer."),
    ],
    async (requests) => {
      const response = await createRagService(
        config,
        embedder,
        store,
        plannerMcp([staffTool("staff")], calls),
      ).chat({
        type: "staff",
        question: "details",
        limit: 5,
        min_score: 0.7,
        staff_id: "STAFF-1",
      });
      assert.equal(response.answer, "Planner fallback answer.");
      assert.deepEqual(calls, [
        {
          name: "staff",
          arguments: { question: "details", staff_id: "STAFF-1" },
        },
      ]);
      assert.equal(requests[0]?.tool_choice, "auto");
      assert.equal("tools" in requests[1]!, false);
    },
  );
});

test("duplicate native tool-call IDs fall back before optional MCP execution", async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  await withPlanner(
    [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_duplicate",
            type: "function",
            function: { name: "staff", arguments: "{}" },
          },
          {
            id: "call_duplicate",
            type: "function",
            function: { name: "team", arguments: "{}" },
          },
        ],
      },
      plannerCall("staff", {}),
      finalAnswer("Planner fallback answer."),
    ],
    async (requests) => {
      const response = await createRagService(
        config,
        embedder,
        store,
        plannerMcp([staffTool("staff"), staffTool("team")], calls),
      ).chat({
        type: "staff",
        question: "details",
        limit: 5,
        min_score: 0.7,
        staff_id: "STAFF-1",
      });
      assert.equal(response.answer, "Planner fallback answer.");
      assert.deepEqual(calls, [
        {
          name: "staff",
          arguments: { question: "details", staff_id: "STAFF-1" },
        },
      ]);
      assert.equal(requests.length, 3);
    },
  );
});

test("native replay capability rejection propagates after optional MCP execution", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("expected JSON body");
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    if (requests.length === 2) {
      return new Response(
        JSON.stringify({ error: { message: "Unsupported parameter: tools" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ choices: [{ message: nativeToolCall("staff", {}) }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) satisfies typeof fetch;
  try {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    const service = createRagService(
      config,
      embedder,
      store,
      plannerMcp([staffTool("staff")], calls),
    );
    await assert.rejects(
      service.chat({
        type: "staff",
        question: "details",
        limit: 5,
        min_score: 0.7,
        staff_id: "STAFF-1",
      }),
      /Unsupported parameter: tools/,
    );
    assert.deepEqual(calls, [
      {
        name: "staff",
        arguments: { question: "details", staff_id: "STAFF-1" },
      },
    ]);
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tools capability rejection falls back to the JSON planner", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("expected JSON body");
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    if (requests.length === 1) {
      return new Response(
        JSON.stringify({ error: { message: "Unsupported parameter: tools" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const message =
      requests.length === 2
        ? plannerCall("staff", {})
        : finalAnswer("Planner fallback answer.");
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) satisfies typeof fetch;
  try {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    const response = await createRagService(
      config,
      embedder,
      store,
      plannerMcp([staffTool("staff")], calls),
    ).chat({
      type: "staff",
      question: "details",
      limit: 5,
      min_score: 0.7,
      staff_id: "STAFF-1",
    });
    assert.equal(response.answer, "Planner fallback answer.");
    assert.equal(requests[0]?.tool_choice, "auto");
    assert.equal("tools" in requests[1]!, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("planner executes exactly three calls in order then synthesizes once", async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const tools = [staffTool("first"), staffTool("second"), staffTool("third")];
  await withPlanner(
    [
      nativeNoCalls(),
      {
        role: "assistant",
        content: JSON.stringify({
          calls: tools.map(({ name }) => ({ name, arguments: {} })),
        }),
      },
      finalAnswer("Synthesized answer"),
    ],
    async (requests) => {
      const response = await createRagService(
        config,
        embedder,
        store,
        plannerMcp(tools, calls),
      ).chat({
        type: "staff",
        question: "details",
        limit: 5,
        min_score: 0.7,
        staff_id: "STAFF-1",
      });
      assert.equal(response.answer, "Synthesized answer");
      assert.deepEqual(
        calls.map(({ name }) => name),
        ["first", "second", "third"],
      );
      assert.equal(requests.length, 3);
    },
  );
});
