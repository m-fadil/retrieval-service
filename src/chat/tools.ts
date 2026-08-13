import type { ChatRequest } from "../schemas/query.js";
import type { FrappeMcpClient, McpChatType, McpTool } from "../services/mcp.js";
import type { SearchHit } from "../services/qdrant.js";
import type { TimedLog } from "./log.js";
import {
  isPlainObject,
  MAX_OPTIONAL_TOOL_CALLS,
  plannedToolKey,
  type PlannedChatTool,
} from "./parse.js";

export const MANDATORY_ENVIRONMENT_TOOL = "get_environment_context";

/** Which path selected the tool. Logged to keep the two distinguishable. */
export type ToolCallMode = "mandatory" | "native" | "planner";

/**
 * Request fields eligible to reach tools. `actor` is excluded: identity travels
 * as a transport header, never as an argument a prompt can read or a model can
 * invent.
 */
export function mcpArgs(input: ChatRequest) {
  const args: Record<string, unknown> = { question: input.question };
  if (input.job_id) args.job_id = input.job_id;
  if (input.staff_id) args.staff_id = input.staff_id;
  if (input.job_schedule_id) args.job_schedule_id = input.job_schedule_id;
  if (input.staff_ids !== undefined) args.staff_ids = input.staff_ids;
  if (input.time_filter) args.time_filter = input.time_filter;
  if (input.include_schedules !== undefined) {
    args.include_schedules = input.include_schedules;
  }
  return args;
}

/**
 * Merges the model's proposed arguments with the request's, request winning. The
 * model selects which tool to call, not which record to call it about.
 */
export function plannedArgs(
  input: ChatRequest,
  planned?: Record<string, unknown>,
) {
  const context = mcpArgs(input);
  const args: Record<string, unknown> = planned
    ? Object.fromEntries(
        Object.entries(planned).filter(([key]) => key !== "type"),
      )
    : { ...context };
  for (const [key, value] of Object.entries(context)) args[key] = value;
  return args;
}

export function nativeTools(tools: McpTool[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: isPlainObject(tool.inputSchema)
        ? tool.inputSchema
        : { type: "object", properties: {} },
    },
  }));
}

export function validPlannedTool(
  plan: PlannedChatTool,
  input: ChatRequest,
  tools: McpTool[],
): PlannedChatTool | null {
  const tool = tools.find((candidate) => candidate.name === plan.name);
  if (!tool) return null;
  const args = plannedArgs(input, plan.arguments);
  const missing = (tool.inputSchema?.required ?? []).filter((key) => {
    const value = args[key];
    return value === undefined || value === "";
  });
  if (missing.length) return null;
  return { name: tool.name, arguments: args };
}

/**
 * Validates a batch of provider-parsed tool calls, rejecting the whole batch on
 * any unexpected entry. All-or-nothing: a partially usable plan is one the
 * planner path can produce correctly instead.
 */
export function validNativeCalls(
  calls: Array<{ id: string; function: { name: string; arguments: string } }>,
  input: ChatRequest,
  tools: McpTool[],
): Array<PlannedChatTool & { id: string }> | null {
  if (!calls.length || calls.length > MAX_OPTIONAL_TOOL_CALLS) return null;
  const plans: Array<PlannedChatTool & { id: string }> = [];
  const callIds = new Set<string>();
  for (const call of calls) {
    if (!call.id || !call.function.name || callIds.has(call.id)) return null;
    callIds.add(call.id);
    try {
      const args: unknown = JSON.parse(call.function.arguments);
      if (!isPlainObject(args)) return null;
      const plan = validPlannedTool(
        { name: call.function.name, arguments: args },
        input,
        tools,
      );
      if (!plan) return null;
      plans.push({ ...plan, id: call.id });
    } catch {
      return null;
    }
  }
  return new Set(plans.map(plannedToolKey)).size === plans.length
    ? plans
    : null;
}

/** Deduplicates plans, so a repeated call is not billed twice. */
export function distinctPlans(plans: PlannedChatTool[]) {
  return new Set(plans.map(plannedToolKey)).size === plans.length;
}

export function mcpResultText(result: {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
}) {
  const text = result.content
    ?.map((item) =>
      item.type === "text" && typeof item.text === "string"
        ? item.text.trim()
        : "",
    )
    .find(Boolean);
  if (text) return text;
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return "MCP tool returned no text.";
}

export function createToolRunner(mcp: FrappeMcpClient) {
  /**
   * Runs one tool and reduces its result to the text the prompts consume. The raw
   * MCP result stops here; forwarding it would echo into `sources` with no
   * consumer.
   */
  return async function runPlannedTool(
    type: McpChatType,
    plan: PlannedChatTool,
    input: ChatRequest,
    tools: McpTool[],
    log: TimedLog,
    mode: ToolCallMode,
  ): Promise<SearchHit[]> {
    const start = performance.now();
    log?.info({ tool: plan.name, mode, status: "started" });
    try {
      const result = await mcp.callTool(
        type,
        plan.name,
        plan.arguments ?? mcpArgs(input),
        tools,
        input.actor,
      );
      const text = mcpResultText(result);
      if (result.isError) throw new Error(text);
      log?.info({
        tool: plan.name,
        mode,
        status: "completed",
        ms: Math.round(performance.now() - start),
      });
      return [
        {
          id: plan.name,
          payload: { text, source: "mcp", tool: plan.name },
        },
      ];
    } catch (error) {
      log?.info({
        tool: plan.name,
        mode,
        status: "error",
        ms: Math.round(performance.now() - start),
      });
      throw error;
    }
  };
}

export type ToolRunner = ReturnType<typeof createToolRunner>;
