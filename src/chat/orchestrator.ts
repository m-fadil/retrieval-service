import type { AppConfig } from "../config.js";
import type { ChatRequest, ChatResponse, ChatUsage } from "../schemas/query.js";
import { FAQ_SOURCE } from "../services/faq.js";
import type { Llm } from "../services/llm.js";
import { NATIVE_TOOL_FEATURE, isCapabilityError } from "../services/llm.js";
import type { FrappeMcpClient, McpChatType, McpTool } from "../services/mcp.js";
import type { SearchHit } from "../services/qdrant.js";
import {
  ChatDeadlineError,
  ChatFailedError,
  timed,
  type ChatLog,
} from "./log.js";
import {
  parsePlannerOutput,
  usableAnswer,
  type PlannedChatTool,
} from "./parse.js";
import {
  ESCALATION_ANSWER,
  PLANNER_JSON_SCHEMA,
  historyMessages,
  nativeReplaySystemPrompt,
  plannerPrompt,
  condensePrompt,
  retrievedAnswerPrompt,
} from "./prompts.js";
import { triage } from "./triage.js";
import {
  MANDATORY_ENVIRONMENT_TOOL,
  createToolRunner,
  distinctPlans,
  mcpArgs,
  nativeTools,
  plannedArgs,
  validNativeCalls,
  validPlannedTool,
  type ToolCallMode,
  type ToolRunner,
} from "./tools.js";

export type Retrieve = (
  question: string,
  limit: number,
  options: { source?: string; signal?: AbortSignal },
) => Promise<SearchHit[]>;

export type ChatFlowDeps = {
  config: Pick<AppConfig, "ASSISTANT_SCOPE" | "CHAT_DEADLINE_MS">;
  llm: Llm;
  mcp: FrappeMcpClient;
  retrieve: Retrieve;
};

function payloadText(hit: SearchHit, key: "answer" | "text") {
  const value = hit.payload?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function composeFaqAnswer(sources: SearchHit[]) {
  return (
    sources.map((hit) => payloadText(hit, "answer")).find(Boolean) ??
    sources.map((hit) => payloadText(hit, "text")).find(Boolean) ??
    "I found a matching FAQ, but it does not include an answer."
  );
}

/**
 * Runs a batch of tool calls concurrently. They are chosen in one pass and do
 * not read each other's output, so serial execution only sums their latencies.
 * Results preserve plan order. The first failure is rethrown after all calls
 * settle — rethrowing earlier leaves the rest unobserved as unhandled
 * rejections.
 */
async function runPlans(
  runTool: ToolRunner,
  type: McpChatType,
  plans: PlannedChatTool[],
  input: ChatRequest,
  tools: McpTool[],
  log: ChatLog | undefined,
  mode: ToolCallMode,
) {
  const settled = await Promise.allSettled(
    plans.map((plan) => runTool(type, plan, input, tools, log, mode)),
  );
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
}

export function createChatFlow(deps: ChatFlowDeps) {
  const { config, llm, mcp, retrieve } = deps;
  const runTool = createToolRunner(mcp);

  type Budget = { usage: ChatUsage; signal: AbortSignal; log?: ChatLog };

  function llmOptions(stage: string, budget: Budget) {
    return {
      stage,
      log: budget.log,
      tally: budget.usage,
      signal: budget.signal,
    };
  }

  /**
   * Skipped without history, which is the case on a first turn, so no extra LLM
   * call is made. A failed rewrite degrades to the raw message rather than
   * failing the chat.
   */
  async function resolveFollowUp(
    input: ChatRequest,
    budget: Budget,
  ): Promise<ChatRequest> {
    if (!input.history?.length) return input;
    try {
      const rewritten = await timed(
        budget.log,
        "chat.condense",
        { turns: input.history.length },
        () =>
          llm.complete(
            condensePrompt(input),
            llmOptions("chat.condense", budget),
          ),
      );
      const question = rewritten.trim();
      return question ? { ...input, question } : input;
    } catch {
      // timed already logged the failure. The raw message is a degraded input,
      // not a failed chat.
      return input;
    }
  }

  async function tryNativeToolCalls(
    input: ChatRequest,
    type: McpChatType,
    tools: McpTool[],
    faqContext: string,
    environmentContext: string,
    budget: Budget,
  ): Promise<{
    answer: string;
    plans: PlannedChatTool[];
    sources: SearchHit[];
  } | null> {
    if (!tools.length || !llm.nativeToolsEnabled()) return null;
    let message;
    try {
      message = await llm.chat(
        {
          messages: [
            ...historyMessages(input),
            { role: "user", content: input.question },
          ],
          tools: nativeTools(tools),
          toolChoice: "auto",
        },
        llmOptions("chat.native_tool_selection", budget),
      );
    } catch (error) {
      if (isCapabilityError(error, NATIVE_TOOL_FEATURE)) {
        // Cached for the life of the process: re-probing a backend without tool
        // calling costs one paid round trip per request for the same result.
        llm.disableNativeTools();
        return null;
      }
      throw error;
    }
    const calls = message.tool_calls;
    if (!calls?.length || !calls.every((call) => call.type === "function")) {
      return null;
    }
    const plans = validNativeCalls(calls, input, tools);
    if (!plans) return null;

    const sources = await runPlans(
      runTool,
      type,
      plans,
      input,
      tools,
      budget.log,
      "native",
    );

    const replay = await llm.chat(
      {
        messages: [
          {
            role: "system",
            content: nativeReplaySystemPrompt(
              mcpArgs(input),
              faqContext,
              environmentContext,
            ),
          },
          ...historyMessages(input),
          { role: "user", content: input.question },
          {
            role: "assistant",
            content: message.content,
            tool_calls: calls,
          },
          ...plans.map((plan, index) => ({
            role: "tool" as const,
            tool_call_id: plan.id,
            content: payloadText(sources[index]!, "text"),
          })),
        ],
        // The catalogue is resent although the results are already in hand:
        // servers extract tool-call syntax from the output only when the request
        // carries `tools` with `tool_choice: "auto"`. Other combinations return
        // the raw text as content, model-specific tokens included. "none" is not
        // safer — the tool definitions still reach the prompt, while the parser's
        // output is discarded.
        tools: nativeTools(tools),
        toolChoice: "auto",
      },
      llmOptions("chat.native_tool_replay", budget),
    );
    // A reply carrying tool_calls is not an answer even alongside prose; the
    // prose is the model narrating its next call.
    const content = replay.tool_calls?.length ? null : replay.content;
    if (usableAnswer(content)) return { answer: content, plans, sources };

    // The model called again instead of answering. Re-asking in the same shape
    // reproduces it, so compose from the results with no `tools` in the request
    // — leaving no syntax in which to express a call.
    budget.log?.info({ stage: "chat.native_tool_replay", status: "unusable" });
    const answer = await timed(
      budget.log,
      "chat.native_tool_recompose",
      {},
      () =>
        llm.complete(
          retrievedAnswerPrompt(
            input,
            faqContext,
            environmentContext,
            sources.map((source) => payloadText(source, "text")),
          ),
          llmOptions("chat.native_tool_recompose", budget),
        ),
    );
    return { answer, plans, sources };
  }

  function mandatoryEnvironmentPlan(input: ChatRequest, tools: McpTool[]) {
    if (!input.job_id) return null;
    const tool = tools.find(
      (candidate) => candidate.name === MANDATORY_ENVIRONMENT_TOOL,
    );
    if (!tool) return null;
    return { name: tool.name, arguments: plannedArgs(input) };
  }

  async function chatFlow(
    request: ChatRequest,
    budget: Budget,
  ): Promise<ChatResponse<SearchHit>> {
    const log = budget.log;
    const input = await resolveFollowUp(request, budget);
    const mcpType: McpChatType = input.type;
    // Scoped to FAQ points: the collection also holds /index documents, whose
    // payloads lack question/answer and surface downstream as blank matches.
    const faqSources = await timed(log, "chat.faq_search", {}, async () =>
      (
        await retrieve(input.question, input.limit, {
          source: FAQ_SOURCE,
          signal: budget.signal,
        })
      ).filter(
        (hit) => hit.score === undefined || hit.score >= input.min_score,
      ),
    );
    let tools: McpTool[];
    try {
      tools = await timed(log, "chat.mcp_list_tools", {}, () =>
        mcp.listTools(mcpType, input.actor),
      );
    } catch (error) {
      const status =
        error instanceof Error
          ? Number(error.message.match(/\b[1-5]\d{2}\b/)?.[0])
          : undefined;
      log?.debug({ operation: "tools/list", status });
      tools = [];
    }
    const environmentPlan = mandatoryEnvironmentPlan(input, tools);
    const environmentSources = environmentPlan
      ? await runTool(mcpType, environmentPlan, input, tools, log, "mandatory")
      : [];
    const sources = [...faqSources, ...environmentSources];
    const environmentContext = environmentSources
      .map((source) => payloadText(source, "text"))
      .filter(Boolean)
      .join("\n");
    const optionalTools = tools.filter(
      (tool) => tool.name !== MANDATORY_ENVIRONMENT_TOOL,
    );
    const faqContext =
      faqSources
        .map(
          (source) =>
            payloadText(source, "answer") || payloadText(source, "text"),
        )
        .join("\n") || "(none)";
    const toolsUsed = [
      "faq_search",
      ...(environmentPlan ? [environmentPlan.name] : []),
    ];

    /**
     * Retrieval returned nothing. Empty retrieval alone does not imply an
     * escalation, so triage decides whether the message wanted data at all.
     */
    async function unretrieved(): Promise<ChatResponse<SearchHit>> {
      const verdict = await triage(
        llm,
        config.ASSISTANT_SCOPE,
        // The raw message, not the condensed question: condensing rewrites "yes
        // please" into a full question, hiding the small talk triage detects.
        request.question,
        input,
        tools,
        faqContext,
        environmentContext,
        { log, tally: budget.usage, signal: budget.signal },
      );
      if (verdict.answerable) {
        return {
          answer: verdict.reply,
          route: "fallback",
          needs_admin: false,
          reason: "conversational",
          tools_used: toolsUsed,
          sources,
        };
      }
      return {
        answer: ESCALATION_ANSWER,
        route: environmentSources.length ? "hybrid" : "fallback",
        needs_admin: true,
        reason:
          verdict.reason ??
          (environmentSources.length ? "insufficient_context" : "no_faq_match"),
        tools_used: toolsUsed,
        sources,
      };
    }

    if (!faqSources.length && !optionalTools.length) return unretrieved();

    const nativeResult = await timed(
      log,
      "chat.native_tool_calls",
      { faq_matches: faqSources.length, tools: optionalTools.length },
      () =>
        tryNativeToolCalls(
          input,
          mcpType,
          optionalTools,
          faqContext,
          environmentContext,
          budget,
        ),
    );
    if (nativeResult) {
      return {
        answer: nativeResult.answer,
        route: "hybrid",
        needs_admin: false,
        reason: "tool_match",
        tools_used: [...toolsUsed, ...nativeResult.plans.map((p) => p.name)],
        sources: [...sources, ...nativeResult.sources],
      };
    }

    const plannerOutput = parsePlannerOutput(
      await timed(
        log,
        "chat.plan",
        { faq_matches: faqSources.length, tools: optionalTools.length },
        () =>
          llm.complete(
            plannerPrompt(
              mcpArgs(input),
              faqContext,
              environmentContext,
              optionalTools,
            ),
            {
              ...llmOptions("chat.plan", budget),
              jsonSchema: PLANNER_JSON_SCHEMA,
            },
          ),
      ),
    );
    const optionalSources: SearchHit[] = [];
    const optionalPlans: PlannedChatTool[] = [];
    if (plannerOutput) {
      const plans = plannerOutput.calls.map((plan) =>
        validPlannedTool(plan, input, optionalTools),
      );
      if (
        plans.every((plan): plan is PlannedChatTool => plan !== null) &&
        distinctPlans(plans)
      ) {
        optionalPlans.push(...plans);
        optionalSources.push(
          ...(await runPlans(
            runTool,
            mcpType,
            plans,
            input,
            tools,
            log,
            "planner",
          )),
        );
      }
    }

    if (!optionalSources.length) {
      if (!faqSources.length) return unretrieved();
      return {
        answer: composeFaqAnswer(sources),
        route: "faq",
        needs_admin: false,
        reason: "faq_match",
        tools_used: toolsUsed,
        sources,
      };
    }

    const finalAnswer = await timed(
      log,
      "chat.compose_answer",
      { sources: sources.length + optionalSources.length },
      () =>
        llm.complete(
          retrievedAnswerPrompt(
            input,
            faqContext,
            environmentContext,
            optionalSources.map((source) => payloadText(source, "text")),
          ),
          llmOptions("chat.compose_answer", budget),
        ),
    );
    return {
      answer: finalAnswer,
      route: "hybrid",
      needs_admin: false,
      reason: "tool_match",
      tools_used: [...toolsUsed, ...optionalPlans.map((plan) => plan.name)],
      sources: [...sources, ...optionalSources],
    };
  }

  /**
   * Wraps the chat flow with per-request accounting and a whole-request
   * deadline: one usage tally summed over every LLM call, the wall-clock
   * duration, and a budget that aborts outbound calls on expiry. Per-call
   * timeouts do not bound the flow — six sequential calls, each retried,
   * compound past any caller's timeout.
   */
  return async function chat(
    request: ChatRequest,
    log?: ChatLog,
  ): Promise<ChatResponse<SearchHit>> {
    const started = performance.now();
    const usage = llm.newUsage();
    const deadline = AbortSignal.timeout(config.CHAT_DEADLINE_MS);
    try {
      const response = await chatFlow(request, {
        usage,
        log,
        signal: deadline,
      });
      const duration_ms = Math.round(performance.now() - started);
      log?.info({ stage: "chat.usage_total", ...usage, duration_ms });
      return { ...response, usage, duration_ms };
    } catch (error) {
      // Calls completed before the failure are still billed, so the partial
      // tally is logged and forwarded rather than discarded with the error.
      const duration_ms = Math.round(performance.now() - started);
      const cause = deadline.aborted
        ? new ChatDeadlineError(config.CHAT_DEADLINE_MS)
        : error;
      log?.info({
        stage: "chat.usage_total",
        ...usage,
        duration_ms,
        failed: true,
        ...(deadline.aborted ? { deadline_exceeded: true } : {}),
      });
      throw new ChatFailedError(cause, usage);
    }
  };
}
