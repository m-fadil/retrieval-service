import type { AppConfig } from "../config.js";
import { createFrappeClient } from "./frappe.js";

const MCP_METHODS = {
  staff: "alpha_fitness.mcp.handle_staff_mcp",
  manager: "alpha_fitness.mcp.handle_manager_mcp",
} as const;

/**
 * The revision this client declares. Pinned to what the server implements:
 * `frappe_mcp` 0.1 answers `initialize` with 2025-03-26.
 *
 * Sent on every hop per the spec's HTTP transports, but unenforced in both
 * directions — the library never reads the header. So it is a declaration, not
 * a negotiation, and a mismatch produces no error. Raising it requires
 * implementing the newer contract on the Frappe side first.
 */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

export type McpChatType = keyof typeof MCP_METHODS;

type JsonRpcId = number;

type JsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type JsonRpcResponse<T> = {
  jsonrpc?: "2.0";
  id?: JsonRpcId | null;
  result?: T;
  error?: JsonRpcError;
};

type FrappeRpcResponse<T> =
  JsonRpcResponse<T> | { message: JsonRpcResponse<T> };

type ToolSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
};

export type McpTool = {
  name: string;
  /**
   * Human-readable name. Always undefined against the current server:
   * `frappe_mcp` 0.1 omits it in `get_validated_tool`. Triage and the planner
   * read it and fall back to `description`, so it stays in the type.
   */
  title?: string;
  description?: string;
  inputSchema?: ToolSchema;
  /** Shape of `structuredContent`, when the tool promises one. */
  outputSchema?: ToolSchema;
};

type ToolsListResult = {
  tools: McpTool[];
  /** Opaque cursor; present only while further pages remain. */
  nextCursor?: string | null;
};

export type McpToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

export interface FrappeMcpClient {
  listTools(type: McpChatType, actor?: string): Promise<McpTool[]>;
  callTool(
    type: McpChatType,
    name: string,
    args: Record<string, unknown>,
    tools?: McpTool[],
    actor?: string,
  ): Promise<McpToolResult>;
}

/**
 * Validates a structured result against the tool's `outputSchema`, per the
 * spec's client-side requirement. Scope is required top-level keys only —
 * enough to detect a tool that stopped returning a field a downstream prompt
 * reads, short of reimplementing JSON Schema.
 */
export function missingStructuredKeys(
  tool: McpTool,
  result: McpToolResult,
): string[] {
  const required = tool.outputSchema?.required;
  if (!required?.length) return [];
  const structured = result.structuredContent;
  if (structured === undefined) return [];
  if (typeof structured !== "object" || structured === null) return required;
  return required.filter((key) => !(key in structured));
}

export function createFrappeMcpClient(
  config: Pick<
    AppConfig,
    | "FRAPPE_URL"
    | "FRAPPE_AUTH_TOKEN"
    | "FRAPPE_TIMEOUT_MS"
    | "MCP_MAX_TOOL_PAGES"
  >,
): FrappeMcpClient {
  const frappe = createFrappeClient(config);
  let id = 0;

  async function rpc<T>(
    type: McpChatType,
    method: string,
    params?: unknown,
    actor?: string,
  ): Promise<T> {
    const response = await frappe.call<FrappeRpcResponse<T>>(
      MCP_METHODS[type],
      {
        jsonrpc: "2.0",
        id: ++id,
        method,
        params: params ?? {},
      },
      { actor, headers: { "mcp-protocol-version": MCP_PROTOCOL_VERSION } },
    );
    const rpcResponse = "message" in response ? response.message : response;
    if (rpcResponse.error) {
      throw new Error(rpcResponse.error.message ?? `${method} failed`);
    }
    if (rpcResponse.result === undefined) {
      throw new Error(`${method} returned no result`);
    }
    return rpcResponse.result;
  }

  /**
   * Follows `nextCursor` to the end of the catalogue, bounded by
   * MCP_MAX_TOOL_PAGES against a server that cursors indefinitely. A truncated
   * catalogue raises no error — the model just never sees the missing tools and
   * declines to answer.
   *
   * One request in practice: `frappe_mcp` 0.1 returns the whole catalogue with
   * `nextCursor` null. The loop covers a server that does paginate.
   */
  async function listTools(type: McpChatType, actor?: string) {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < config.MCP_MAX_TOOL_PAGES; page++) {
      const result = await rpc<ToolsListResult>(
        type,
        "tools/list",
        cursor === undefined ? {} : { cursor },
        actor,
      );
      tools.push(...(result.tools ?? []));
      if (!result.nextCursor) return tools;
      cursor = result.nextCursor;
    }
    throw new Error(
      `tools/list still paginating after ${config.MCP_MAX_TOOL_PAGES} pages`,
    );
  }

  /**
   * Filters args to `inputSchema.properties`; empty properties yields `{}`.
   *
   * The only enforcement point: `frappe_mcp` 0.1 applies args as
   * `fn(**arguments)` with no schema check, so every key surviving this filter
   * becomes a Python keyword argument. Unfiltered, a planner-invented key
   * reaches a tool whose schema omits it, and a zero-parameter tool raises
   * TypeError.
   */
  function allowedArgs(tool: McpTool, args: Record<string, unknown>) {
    const properties = tool.inputSchema?.properties ?? {};
    return Object.fromEntries(
      Object.entries(args).filter(
        ([key]) => key !== "type" && key in properties,
      ),
    );
  }

  function validateRequired(tool: McpTool, args: Record<string, unknown>) {
    const missing = (tool.inputSchema?.required ?? []).filter((key) => {
      const value = args[key];
      return value === undefined || value === "";
    });
    if (missing.length) {
      throw new Error(
        `${tool.name} missing required args: ${missing.join(", ")}`,
      );
    }
  }

  return {
    listTools,
    async callTool(type, name, args, tools, actor) {
      const availableTools = tools ?? (await listTools(type, actor));
      const tool = availableTools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`MCP tool not found: ${name}`);
      const filteredArgs = allowedArgs(tool, args);
      validateRequired(tool, filteredArgs);
      const result = await rpc<McpToolResult>(
        type,
        "tools/call",
        { name, arguments: filteredArgs },
        actor,
      );
      const missing = missingStructuredKeys(tool, result);
      if (missing.length) {
        throw new Error(
          `${name} structured result is missing: ${missing.join(", ")}`,
        );
      }
      return result;
    },
  };
}
