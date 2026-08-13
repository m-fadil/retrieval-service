import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_CALLBACK_METHOD,
  createChatDispatcher,
} from "../src/services/dispatch.js";
import type { ChatResponse } from "../src/schemas/query.js";
import type { SearchHit } from "../src/services/qdrant.js";
import { ChatFailedError, type ChatLog } from "../src/services/rag.js";

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
    // No question echo: Frappe's audit log strips text keys.
    answer: "Use the QR scanner.",
    route: "faq",
    reason: "faq_match",
    needs_admin: false,
    tools_used: ["faq_search"],
    // Ids only — FAQ text must not travel back.
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
    cached_prompt_tokens: 0,
    reasoning_tokens: 0,
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
  // A failed chat still reports elapsed time. A plain error carries no tally, so
  // there is no usage to send.
  assert.equal(typeof calls[0]!.body.duration_ms, "number");
  assert.ok(!("usage" in calls[0]!.body));
});

test("dispatch forwards the partial usage of a failed chat", async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const usage = {
    model: "large",
    llm_calls: 2,
    prompt_tokens: 2000,
    completion_tokens: 40,
    total_tokens: 2040,
    cached_prompt_tokens: 1024,
    reasoning_tokens: 12,
  };
  const dispatcher = createChatDispatcher(
    {
      async chat() {
        // What rag.chat throws when the flow fails after some LLM calls completed;
        // the billed calls' tally travels on the error.
        throw new ChatFailedError(new Error("compose timeout"), usage);
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

  assert.equal(calls[0]!.body.needs_admin, true);
  assert.equal(calls[0]!.body.reason, "chat_failed");
  // The failed chat's spend still reaches the audit log.
  assert.deepEqual(calls[0]!.body.usage, usage);
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

test("dispatch runs no more jobs at once than its concurrency allows", async () => {
  let running = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  const dispatcher = createChatDispatcher(
    {
      async chat() {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => release.push(resolve));
        running -= 1;
        return chatResponse;
      },
    },
    {
      async call<T>() {
        return {} as T;
      },
    },
    [],
    { maxConcurrent: 2, maxQueued: 10 },
  );

  const jobs = Array.from({ length: 5 }, (_, at) =>
    dispatcher.dispatch(input, { ...envelope, request_id: `req-${at}` }),
  );
  // Each job costs three to six paid LLM calls, so a burst must not fan out into
  // all of them concurrently.
  while (release.length < 2) await new Promise(setImmediate);
  assert.equal(dispatcher.pending(), 5);

  for (let settled = 0; settled < 5; settled += 1) {
    while (!release.length) await new Promise(setImmediate);
    release.shift()!();
    await new Promise(setImmediate);
  }
  await Promise.all(jobs);
  assert.equal(peak, 2);
  assert.equal(dispatcher.pending(), 0);
});

test("dispatch refuses to queue past its backlog limit", async () => {
  const release: Array<() => void> = [];
  const dispatcher = createChatDispatcher(
    {
      async chat() {
        await new Promise<void>((resolve) => release.push(resolve));
        return chatResponse;
      },
    },
    {
      async call<T>() {
        return {} as T;
      },
    },
    [],
    { maxConcurrent: 1, maxQueued: 1 },
  );

  const first = dispatcher.dispatch(input, envelope);
  const second = dispatcher.dispatch(input, envelope);
  while (!release.length) await new Promise(setImmediate);
  // One running, one queued: the route answers 503 rather than accepting a job it
  // cannot guarantee to run.
  assert.equal(dispatcher.accepts(), false);

  release.shift()!();
  await first;
  while (!release.length) await new Promise(setImmediate);
  assert.equal(dispatcher.accepts(), true);
  release.shift()!();
  await second;
});

test("drain waits for queued jobs, not just the running ones", async () => {
  const delivered: string[] = [];
  const release: Array<() => void> = [];
  const dispatcher = createChatDispatcher(
    {
      async chat() {
        await new Promise<void>((resolve) => release.push(resolve));
        return chatResponse;
      },
    },
    {
      async call<T>(_method: string, body?: unknown) {
        delivered.push(String((body as { request_id: string }).request_id));
        return {} as T;
      },
    },
    [],
    { maxConcurrent: 1, maxQueued: 10 },
  );

  void dispatcher.dispatch(input, { ...envelope, request_id: "req-1" });
  void dispatcher.dispatch(input, { ...envelope, request_id: "req-2" });
  const drained = dispatcher.drain();
  // Both callbacks must be delivered before shutdown completes; the LLM calls
  // behind them are already billed.
  for (let settled = 0; settled < 2; settled += 1) {
    while (!release.length) await new Promise(setImmediate);
    release.shift()!();
    await new Promise(setImmediate);
  }
  await drained;
  assert.deepEqual(delivered, ["req-1", "req-2"]);
  assert.equal(dispatcher.pending(), 0);
});
