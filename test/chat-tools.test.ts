/** Tool selection: the native path, the JSON planner, and the fallbacks
 * between them. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatDeadlineError,
  ChatFailedError,
  createRagService,
} from "../src/services/rag.js";
import type { VectorStore } from "../src/services/qdrant.js";
import {
  type ChatResponseMessage,
  config,
  embedder,
  faq,
  finalAnswer,
  nativeNoCalls,
  nativeToolCall,
  plannerCall,
  plannerMcp,
  staffTool,
  store,
  withPlanner,
} from "./fixtures.js";

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

/**
 * Replay replies that are not answers: unparsed special tokens passed through
 * (DeepSeek and Qwen dialects), a tool call with no prose, and empty content.
 */
const unusableReplies: Array<[string, ChatResponseMessage]> = [
  [
    "deepseek markup",
    finalAnswer(
      'Let me search more broadly for job-related information.\n\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="staff">\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>',
    ),
  ],
  ["qwen markup", finalAnswer('<tool_call>{"name": "staff"}</tool_call>')],
  ["a call and no prose", nativeToolCall("staff", {}, "call_again")],
  [
    // Parsed correctly here, but the prose is still not an answer — it is the
    // model narrating its next call.
    "a call with prose",
    {
      ...nativeToolCall("staff", {}, "call_again"),
      content: "Let me search more broadly for job-related information.",
    },
  ],
  ["nothing at all", finalAnswer("   ")],
];

for (const [label, reply] of unusableReplies) {
  test(`native replay that is not an answer is recomposed: ${label}`, async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    await withPlanner(
      [nativeToolCall("staff", {}), reply, finalAnswer("Recomposed answer.")],
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
        assert.equal(response.answer, "Recomposed answer.");
        assert.equal(response.reason, "tool_match");
        // One tool run: recompose reuses the results in hand instead of fetching
        // them again.
        assert.deepEqual(calls, [
          {
            name: "staff",
            arguments: { question: "details", staff_id: "STAFF-1" },
          },
        ]);
        assert.equal(requests.length, 3);
        // No catalogue on the recompose, so no syntax remains in which to express
        // another call.
        assert.equal("tools" in requests[2]!, false);
        const recompose = requests[2]!.messages as Array<
          Record<string, unknown>
        >;
        assert.match(String(recompose[0]?.content), /staff result/);
      },
    );
  });
}

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

test("independent tool calls run together, not one after another", async () => {
  const started: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mcp = {
    async listTools() {
      return [staffTool("first"), staffTool("second"), staffTool("third")];
    },
    async callTool(_type: unknown, name: string) {
      started.push(name);
      await held;
      return { content: [{ type: "text", text: `${name} result` }] };
    },
  };

  await withPlanner(
    [
      nativeNoCalls(),
      {
        role: "assistant",
        content: JSON.stringify({
          calls: [
            { name: "first", arguments: {} },
            { name: "second", arguments: {} },
            { name: "third", arguments: {} },
          ],
        }),
      },
      finalAnswer("Synthesized."),
    ],
    async () => {
      const chat = createRagService(
        config,
        embedder,
        store,
        mcp as Parameters<typeof createRagService>[3],
      ).chat({
        type: "staff",
        question: "details",
        limit: 5,
        min_score: 0.7,
        staff_id: "STAFF-1",
      });
      // All three in flight before any returns: the plan is chosen in one pass and
      // no call reads another's output, so serial execution only sums latencies.
      while (started.length < 3) await new Promise(setImmediate);
      release();
      const response = await chat;
      assert.equal(response.answer, "Synthesized.");
      assert.deepEqual(started, ["first", "second", "third"]);
    },
  );
});

test("a chat that outlives its deadline fails with the partial tally", async () => {
  const originalFetch = globalThis.fetch;
  // A provider that never answers and returns only on abort.
  globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("The operation was aborted")),
      );
    })) as typeof fetch;
  try {
    const service = createRagService(
      { ...config, CHAT_DEADLINE_MS: 25 },
      embedder,
      store,
      plannerMcp([staffTool("staff")], []),
    );
    const failure = await service
      .chat({
        type: "staff",
        question: "details",
        limit: 5,
        min_score: 0.7,
        staff_id: "STAFF-1",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    // Per-call timeouts bound one call; this bounds the whole flow, so a caller
    // does not wait out six retried calls in sequence.
    assert.ok(failure instanceof ChatFailedError);
    assert.ok(failure.cause instanceof ChatDeadlineError);
    assert.match(failure.message, /exceeded its 25ms deadline/);
    // The tally still travels, so the audit log records the spend.
    assert.equal(failure.usage.model, config.OPENAI_MODEL);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a second tool turn runs on the first turn's results, then answers", async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  await withPlanner(
    [
      nativeToolCall("today_schedule", {}),
      nativeToolCall("job_context", {}),
      finalAnswer("You open the Zumba class at 09:00."),
    ],
    async (requests) => {
      const service = createRagService(
        config,
        embedder,
        store,
        plannerMcp(
          [
            staffTool("today_schedule", "Today's schedules for a staff member"),
            staffTool("job_context", "Context for one job"),
          ],
          calls,
        ),
      );
      const response = await service.chat({
        type: "staff",
        question: "what do I open today?",
        limit: 5,
        min_score: 0.7,
        staff_id: "STAFF-1",
      });
      assert.equal(response.answer, "You open the Zumba class at 09:00.");
      assert.deepEqual(
        calls.map((call) => call.name),
        ["today_schedule", "job_context"],
      );
      // Three LLM calls, not a recompose: the third turn answered by itself.
      assert.equal(requests.length, 3);
      assert.equal(response.needs_admin, false);
      assert.deepEqual(response.tools_used, [
        "faq_search",
        "today_schedule",
        "job_context",
      ]);
      // The second turn must carry the first turn's result back, or the loop is
      // a re-ask rather than a continuation.
      assert.match(
        JSON.stringify(requests[1]?.messages),
        /today_schedule result/,
      );
    },
  );
});

test("a turn repeating a batch already run stops the loop", async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  await withPlanner(
    [
      nativeToolCall("today_schedule", {}),
      nativeToolCall("today_schedule", {}),
      finalAnswer("Composed from what was already fetched."),
    ],
    async () => {
      const service = createRagService(
        config,
        embedder,
        store,
        plannerMcp(
          [staffTool("today_schedule", "Today's schedules for a staff member")],
          calls,
        ),
      );
      const response = await service.chat({
        type: "staff",
        question: "what do I open today?",
        limit: 5,
        min_score: 0.7,
        staff_id: "STAFF-1",
      });
      // Called once, not twice: the repeated batch ends the loop and the answer
      // is recomposed from the result in hand.
      assert.equal(calls.length, 1);
      assert.equal(response.answer, "Composed from what was already fetched.");
      assert.equal(response.needs_admin, false);
    },
  );
});
