/**
 * LLM client negotiation with an OpenAI-compatible backend: Structured Outputs
 * where implemented, the prompt-only shape where not, and the same one-time
 * degradation for native tool calling.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createLlm } from "../src/services/llm.js";
import { config } from "./fixtures.js";

type Reply = {
  message?: Record<string, unknown>;
  status?: number;
  body?: string;
};

async function withProvider<T>(
  replies: Reply[],
  run: (requests: Array<Record<string, unknown>>) => Promise<T>,
) {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected LLM request");
    if (reply.status) {
      return new Response(reply.body ?? "boom", { status: reply.status });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: reply.message }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const schema = {
  name: "verdict",
  schema: { type: "object", properties: { ok: { type: "boolean" } } },
};

test("a JSON contract is sent as a strict json_schema response format", async () => {
  await withProvider(
    [{ message: { content: '{"ok":true}' } }],
    async (requests) => {
      const llm = createLlm(config);
      assert.equal(
        await llm.complete("decide", { stage: "test", jsonSchema: schema }),
        '{"ok":true}',
      );
      const format = requests[0]?.response_format as {
        type: string;
        json_schema: { name: string; strict: boolean };
      };
      // The prompt-only alternative this replaces carries no shape guarantee.
      assert.equal(format.type, "json_schema");
      assert.equal(format.json_schema.name, "verdict");
      assert.equal(format.json_schema.strict, true);
    },
  );
});

test("a backend without Structured Outputs is retried once and remembered", async () => {
  await withProvider(
    [
      {
        status: 400,
        body: JSON.stringify({
          error: { message: "Unsupported parameter: response_format" },
        }),
      },
      { message: { content: '{"ok":true}' } },
      { message: { content: '{"ok":false}' } },
    ],
    async (requests) => {
      const llm = createLlm(config);
      await llm.complete("decide", { stage: "test", jsonSchema: schema });
      await llm.complete("decide again", { stage: "test", jsonSchema: schema });

      assert.equal(requests.length, 3);
      assert.ok("response_format" in requests[0]!);
      assert.equal("response_format" in requests[1]!, false);
      // No second probe: a rejection is paid once per process, not per request.
      assert.equal("response_format" in requests[2]!, false);
    },
  );
});

test("LLM_JSON_SCHEMA=off never asks for a response format", async () => {
  await withProvider([{ message: { content: "{}" } }], async (requests) => {
    const llm = createLlm({ ...config, LLM_JSON_SCHEMA: "off" });
    await llm.complete("decide", { stage: "test", jsonSchema: schema });
    assert.equal("response_format" in requests[0]!, false);
  });
});

test("LLM_JSON_SCHEMA=on lets the rejection surface instead of degrading", async () => {
  await withProvider(
    [
      {
        status: 400,
        body: JSON.stringify({
          error: { message: "Unsupported parameter: response_format" },
        }),
      },
    ],
    async (requests) => {
      const llm = createLlm({ ...config, LLM_JSON_SCHEMA: "on" });
      await assert.rejects(() =>
        llm.complete("decide", { stage: "test", jsonSchema: schema }),
      );
      assert.equal(requests.length, 1);
    },
  );
});

test("native tool calling is disabled for the process once refused", async () => {
  const llm = createLlm(config);
  assert.equal(llm.nativeToolsEnabled(), true);
  llm.disableNativeTools();
  assert.equal(llm.nativeToolsEnabled(), false);

  // "on" is an operator assertion that the backend supports it, so an unrelated
  // error message must not switch the flow to the planner.
  const required = createLlm({ ...config, LLM_NATIVE_TOOLS: "on" });
  required.disableNativeTools();
  assert.equal(required.nativeToolsEnabled(), true);

  assert.equal(
    createLlm({ ...config, LLM_NATIVE_TOOLS: "off" }).nativeToolsEnabled(),
    false,
  );
});

test("the usage tally records cached and reasoning tokens separately", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "hi" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 80 },
          completion_tokens_details: { reasoning_tokens: 15 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const llm = createLlm(config);
    const tally = llm.newUsage();
    await llm.complete("hi", { stage: "test", tally });
    // Reasoning tokens bill as output but are absent from the answer, and cached
    // prompt tokens bill at a discount, so a tally omitting either misreports
    // cost.
    assert.deepEqual(tally, {
      model: config.OPENAI_MODEL,
      llm_calls: 1,
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cached_prompt_tokens: 80,
      reasoning_tokens: 15,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
