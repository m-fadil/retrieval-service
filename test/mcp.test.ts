/**
 * MCP client conformance for the parts with observable consequences: catalogue
 * pagination, argument filtering, and structured results.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MCP_PROTOCOL_VERSION,
  createFrappeMcpClient,
  missingStructuredKeys,
} from "../src/services/mcp.js";
import { config } from "./fixtures.js";

type Rpc = { method: string; params?: Record<string, unknown> };

/**
 * Stubs the Frappe endpoint, answering each JSON-RPC request from `results` in
 * order and recording the requests and their headers.
 */
async function withMcp<T>(
  results: unknown[],
  run: (
    client: ReturnType<typeof createFrappeMcpClient>,
    calls: Rpc[],
    headers: Array<Record<string, string>>,
  ) => Promise<T>,
) {
  const originalFetch = globalThis.fetch;
  const calls: Rpc[] = [];
  const headers: Array<Record<string, string>> = [];
  globalThis.fetch = (async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)) as Rpc);
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const result = results.shift();
    if (result === undefined) throw new Error("unexpected MCP request");
    return new Response(
      JSON.stringify({ message: { jsonrpc: "2.0", result } }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  try {
    return await run(createFrappeMcpClient(config), calls, headers);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("tools/list follows nextCursor to the end of the catalogue", async () => {
  await withMcp(
    [
      { tools: [{ name: "first" }], nextCursor: "page-2" },
      { tools: [{ name: "second" }], nextCursor: null },
    ],
    async (client, calls) => {
      const tools = await client.listTools("staff");
      // Reading only the first page drops tools with no error: the model never
      // sees them and declines to answer.
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["first", "second"],
      );
      assert.deepEqual(calls[0]?.params, {});
      assert.deepEqual(calls[1]?.params, { cursor: "page-2" });
    },
  );
});

test("tools/list stops rather than following a cursor forever", async () => {
  const endless = Array.from({ length: 30 }, () => ({
    tools: [{ name: "same" }],
    nextCursor: "again",
  }));
  await withMcp(endless, async (client, calls) => {
    await assert.rejects(
      () => client.listTools("staff"),
      /still paginating after 20 pages/,
    );
    assert.equal(calls.length, config.MCP_MAX_TOOL_PAGES);
  });
});

test("every hop declares the MCP revision it speaks", async () => {
  await withMcp([{ tools: [] }], async (client, _calls, headers) => {
    await client.listTools("staff");
    assert.equal(headers[0]?.["mcp-protocol-version"], MCP_PROTOCOL_VERSION);
  });
});

test("a refusal from the server keeps the reason it gave", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    // frappe_mcp returns JSON-RPC failures as a 400 whose body names the reason.
    // Without the body, the endpoint, the method and the params are
    // indistinguishable as causes.
    await assert.rejects(
      () => createFrappeMcpClient(config).listTools("staff"),
      /Method not found/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only advertised arguments reach a tool", async () => {
  await withMcp(
    [{ content: [{ type: "text", text: "ok" }] }],
    async (client, calls) => {
      await client.callTool(
        "staff",
        "get_staff",
        { staff_id: "STAFF-1", question: "when", invented: "drop me" },
        [
          {
            name: "get_staff",
            inputSchema: {
              required: ["staff_id"],
              properties: { staff_id: {}, question: {} },
            },
          },
        ],
      );
      assert.deepEqual(calls[0]?.params?.arguments, {
        staff_id: "STAFF-1",
        question: "when",
      });
    },
  );
});

test("a tool that declares no properties receives no arguments", async () => {
  await withMcp(
    [{ content: [{ type: "text", text: "ok" }] }],
    async (client, calls) => {
      await client.callTool("staff", "ping", { question: "hi" }, [
        { name: "ping", inputSchema: { type: "object" } },
      ]);
      // Unfiltered, a planner-invented key absent from every schema reaches the
      // tool.
      assert.deepEqual(calls[0]?.params?.arguments, {});
    },
  );
});

test("a structured result missing a promised field is an error", async () => {
  const tool = {
    name: "weather",
    outputSchema: { required: ["temperature", "conditions"] },
  };
  assert.deepEqual(
    missingStructuredKeys(tool, {
      structuredContent: { temperature: 21 },
    }),
    ["conditions"],
  );
  // No schema to check against, or no structured content returned: not an error.
  assert.deepEqual(missingStructuredKeys(tool, { content: [] }), []);
  assert.deepEqual(
    missingStructuredKeys({ name: "plain" }, { structuredContent: {} }),
    [],
  );

  await withMcp(
    [{ structuredContent: { temperature: 21 } }],
    async (client) => {
      await assert.rejects(
        () => client.callTool("staff", "weather", {}, [tool]),
        /structured result is missing: conditions/,
      );
    },
  );
});
