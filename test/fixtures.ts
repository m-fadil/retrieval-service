/**
 * Shared fixtures for the HTTP and chat-flow suites. Extracted here so the
 * suites can be split by what they exercise rather than by what they share.
 */
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
import type { ChatDispatcher } from "../src/services/dispatch.js";

export const config: AppConfig = {
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
  // High enough that the shared app fixture never rate limits mid-suite.
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
  ASSISTANT_SCOPE: "staff and manager questions about jobs and schedules",
};

/** Every route except /health requires the shared API key. */
export const authHeaders = {
  authorization: `Bearer ${config.RETRIEVAL_API_KEY}`,
};

export const embedder: Embedder = {
  async embed() {
    return [1];
  },
};

export const store: VectorStore = {
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

export const faqStore: VectorStore = {
  ...store,
  async search() {
    return [{ id: "faq", score: 0.9, payload: { text: "FAQ context" } }];
  },
};

export const rag: RagService = {
  async index(input) {
    return { indexed: input.documents.length };
  },
  async search(input) {
    const sources = [
      { id: "hit-1", score: 0.85, payload: { text: input.question } },
      { id: "hit-2", score: 0.2, payload: { text: "unrelated" } },
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
      { id: "hit-2", score: 0.2, payload: { text: "unrelated" } },
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

export const faq: FaqService = {
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

export type McpRequest = {
  id: number;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

export type ChatRequestBody = {
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string;
};

export type ChatResponseMessage = Record<string, unknown>;

export async function withMockMcp<T>(
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

export const plannerCall = (
  name: string,
  arguments_: Record<string, unknown>,
) => ({
  role: "assistant",
  content: JSON.stringify({ calls: [{ name, arguments: arguments_ }] }),
});

export const finalAnswer = (content: string) => ({
  role: "assistant",
  content,
});

/**
 * Stubs the LLM endpoint only, serving `responses` in order. For tests that
 * inject their own MCP client and never reach Frappe over HTTP.
 */
export async function withLlm<T>(
  responses: ChatResponseMessage[],
  run: (requests: ChatRequestBody[]) => Promise<T>,
) {
  const originalFetch = globalThis.fetch;
  const requests: ChatRequestBody[] = [];
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://llm.example.test/v1/chat/completions");
    assert.equal(init?.method, "POST");
    if (typeof init?.body !== "string") throw new Error("expected JSON body");
    requests.push(JSON.parse(init.body) as ChatRequestBody);
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

/** Expected triage output when retrieval returns empty. */
export const triageVerdict = (kind: string, reply = "") =>
  finalAnswer(JSON.stringify({ kind, reply }));

/** Nothing indexed and no tools, so every chat reaches the triage step. */
export const noTools = {
  async listTools() {
    return [];
  },
  async callTool(): Promise<never> {
    throw new Error("MCP should not be called");
  },
};

/**
 * Strips the per-request accounting (usage, duration_ms) every chat response
 * appends, for tests asserting the answer contract. The accounting fields have
 * their own test.
 */
export function withoutAccounting(body: object) {
  const {
    usage: _usage,
    duration_ms: _duration,
    ...rest
  } = body as Record<string, unknown>;
  return rest;
}

export const nativeToolCall = (
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

export const nativeToolResponses = (
  name: string,
  arguments_: Record<string, unknown>,
  answer: string,
) => [nativeToolCall(name, arguments_), finalAnswer(answer)];

export function assertNativeToolFlow(
  requests: ChatRequestBody[],
  expectedTool: string,
) {
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.tool_choice, "auto");
  assert.match(
    JSON.stringify(requests[0]?.tools),
    new RegExp(`"name":"${expectedTool}"`),
  );
  // The replay carries the catalogue as well, under the only combination that
  // makes a server extract tool syntax instead of returning it as text.
  assert.match(
    JSON.stringify(requests[1]?.tools),
    new RegExp(`"name":"${expectedTool}"`),
  );
  assert.equal(requests[1]?.tool_choice, "auto");
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

/**
 * A dispatcher recording what it was handed. Always accepts; the backlog guard
 * has its own test.
 */
export function stubDispatcher(
  dispatch: ChatDispatcher["dispatch"],
): ChatDispatcher {
  return {
    dispatch,
    accepts: () => true,
    pending: () => 0,
    async drain() {},
  };
}

/**
 * Fixture for the condense-step tests: records embedded text, returns one FAQ
 * hit, and serves the queued LLM messages in order.
 */
export async function withCondenseChat<T>(
  responses: Array<ChatResponseMessage | { status: number }>,
  run: (context: {
    app: ReturnType<typeof buildApp>;
    embedded: string[];
    llmBodies: ChatRequestBody[];
  }) => Promise<T>,
) {
  const embedded: string[] = [];
  const llmBodies: ChatRequestBody[] = [];
  const recorder: Embedder = {
    async embed(text) {
      embedded.push(text);
      return [1];
    },
  };
  const chatStore: VectorStore = {
    ...store,
    async search() {
      return [
        {
          id: "faq-sandwich",
          score: 0.9,
          payload: { answer: "Try the club sandwich." },
        },
      ];
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://llm.example.test/v1/chat/completions");
    if (typeof init?.body !== "string") throw new Error("expected JSON body");
    llmBodies.push(JSON.parse(init.body) as ChatRequestBody);
    const message = responses.shift();
    if (!message) throw new Error("unexpected LLM request");
    if ("status" in message && typeof message.status === "number") {
      return new Response("boom", { status: message.status });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message }],
        // Fixed per-call usage so the aggregation test can predict totals. The
        // details sub-tallies are what a reasoning model bills on top of the
        // headline numbers, and are summed separately.
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) satisfies typeof fetch;
  try {
    const service = createRagService(config, recorder, chatStore, {
      async listTools() {
        return [];
      },
      async callTool() {
        throw new Error("MCP should not be called");
      },
    });
    const app = buildApp({ config, store, rag: service, faq });
    return await run({ app, embedded, llmBodies });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export type PlannerMcp = Parameters<typeof createRagService>[3];

export const nativeNoCalls = () => ({ role: "assistant", content: null });

export async function withPlanner<T>(
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

export function plannerMcp(
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

export const staffTool = (
  name: string,
  description = "Returns staff details",
) => ({
  name,
  description,
  inputSchema: {
    required: ["staff_id"],
    properties: { staff_id: {}, question: {} },
  },
});
