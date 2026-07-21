import type { AppConfig } from "../config.js";
import { createFrappeClient } from "./frappe.js";

const MCP_METHODS = {
  staff: "alpha_fitness.mcp.handle_staff_mcp",
  manager: "alpha_fitness.mcp.handle_manager_mcp",
} as const;

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

type ToolInputSchema = {
  required?: string[];
  properties?: Record<string, unknown>;
};

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: ToolInputSchema;
};

type ToolsListResult = {
  tools: McpTool[];
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

export function createFrappeMcpClient(
  config: Pick<
    AppConfig,
    "FRAPPE_URL" | "FRAPPE_AUTH_TOKEN" | "FRAPPE_TIMEOUT_MS"
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
      actor,
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

  async function listTools(type: McpChatType, actor?: string) {
    return (await rpc<ToolsListResult>(type, "tools/list", {}, actor)).tools;
  }

  function allowedArgs(tool: McpTool, args: Record<string, unknown>) {
    const properties = tool.inputSchema?.properties;
    return Object.fromEntries(
      Object.entries(args).filter(
        ([key]) => key !== "type" && (!properties || key in properties),
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
      return rpc<McpToolResult>(
        type,
        "tools/call",
        { name, arguments: filteredArgs },
        actor,
      );
    },
  };
}
