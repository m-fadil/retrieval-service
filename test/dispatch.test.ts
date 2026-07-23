import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_CALLBACK_METHOD,
  createChatDispatcher,
} from "../src/services/dispatch.js";
import type { ChatResponse } from "../src/schemas/query.js";
import type { SearchHit } from "../src/services/qdrant.js";
import type { ChatLog } from "../src/services/rag.js";

const input = {
  question: "How do I check in?",
  limit: 3,
  min_score: 0.7,
  type: "staff" as const,
};

const envelope = { request_id: "req-1", session_id: "CHAT-1" };

const chatResponse: ChatResponse<SearchHit> = {
  answer: "Use the QR scanner.",
  route: "faq",
  needs_admin: false,
  reason: "faq_match",
  tools_used: ["faq_search"],
  sources: [{ id: "FAQ-1", score: 0.9, payload: { text: "secret text" } }],
};

test("dispatch delivers the chat result to the Frappe callback", async () => {
  const calls: Array<{ method: string; body: unknown }> = [];
  const dispatcher = createChatDispatcher(
    {
      async chat() {
        return chatResponse;
      },
    },
    {
      async call<T>(method: string, body?: unknown) {
        calls.push({ method, body });
        return {} as T;
      },
    },
    [],
  );

  await dispatcher.dispatch(input, envelope);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, CHAT_CALLBACK_METHOD);
  const { duration_ms, ...body } = calls[0]!.body as Record<string, unknown>;
  assert.equal(typeof duration_ms, "number");
  assert.deepEqual(body, {
    session_id: "CHAT-1",
    request_id: "req-1",
    question: "How do I check in?",
    answer: "Use the QR scanner.",
    route: "faq",
    reason: "faq_match",
    needs_admin: false,
    tools_used: ["faq_search"],
    // Ids only — the FAQ text must not travel back.
    sources: [{ id: "FAQ-1" }],
  });
});

test("dispatch forwards token usage to the callback", async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const usage = {
    model: "large",
    llm_calls: 2,
    prompt_tokens: 20,
    completion_tokens: 10,
    total_tokens: 30,
  };
  const dispatcher = createChatDispatcher(
    {
      async chat() {
        return { ...chatResponse, usage };
      },
    },
    {
      async call<T>(_method: string, body?: unknown) {
        calls.push({ body: body as Record<string, unknown> });
        return {} as T;
      },
    },
    [],
  );

  await dispatcher.dispatch(input, envelope);

  assert.deepEqual(calls[0]!.body.usage, usage);
});

test("dispatch escalates through the callback when chat fails", async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const dispatcher = createChatDispatcher(
    {
      async chat() {
        throw new Error("LLM down");
      },
    },
    {
      async call<T>(_method: string, body?: unknown) {
        calls.push({ body: body as Record<string, unknown> });
        return {} as T;
      },
    },
    [],
  );

  await dispatcher.dispatch(input, envelope);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.needs_admin, true);
  assert.equal(calls[0]!.body.reason, "chat_failed");
  assert.equal(calls[0]!.body.request_id, "req-1");
  // Even a failed chat reports how long it burned; there is no usage to send.
  assert.equal(typeof calls[0]!.body.duration_ms, "number");
  assert.ok(!("usage" in calls[0]!.body));
});

test("dispatch retries callback delivery until it succeeds", async () => {
  let attempts = 0;
  const dispatcher = createChatDispatcher(
    {
      async chat() {
        return chatResponse;
      },
    },
    {
      async call<T>() {
        attempts += 1;
        if (attempts < 3) throw new Error("Frappe 502");
        return {} as T;
      },
    },
    [0, 0, 0],
  );

  await dispatcher.dispatch(input, envelope);

  assert.equal(attempts, 3);
});

test("dispatch abandons delivery after exhausting retries and logs it", async () => {
  let attempts = 0;
  const errors: string[] = [];
  const dispatcher = createChatDispatcher(
    {
      async chat() {
        return chatResponse;
      },
    },
    {
      async call<T>(): Promise<T> {
        attempts += 1;
        throw new Error("Frappe down");
      },
    },
    [0, 0],
  );

  const log: ChatLog = {
    debug() {},
    info() {},
    error(_details: unknown, message?: string) {
      if (message) errors.push(message);
    },
  };
  await dispatcher.dispatch(input, envelope, log);

  // 1 initial try + 2 retries.
  assert.equal(attempts, 3);
  assert.ok(errors.includes("chat callback abandoned after retries"));
});
