import type { AppConfig } from "../config.js";
import type { ChatRequest, ChatResponse, ChatUsage } from "../schemas/query.js";
import { FAQ_SOURCE } from "../services/faq.js";
import type { Llm, LlmChatParams } from "../services/llm.js";
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
  plannedToolKey,
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
  config: Pick<
    AppConfig,
    "ASSISTANT_SCOPE" | "CHAT_DEADLINE_MS" | "CHAT_MAX_TOOL_TURNS"
  >;
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
    const log = budget.log;
    const catalogue = nativeTools(tools);
    // One conversation carried across turns, so a second round sees the first
    // round's results. The system prompt is present from the first turn: it
    // carries the trusted request context the model needs to fill required
    // arguments it cannot invent (job_id, staff_id).
    const messages: LlmChatParams["messages"] = [
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
    ];
    const allPlans: PlannedChatTool[] = [];
    const allSources: SearchHit[] = [];
    const ranBatches = new Set<string>();

    for (let turn = 0; turn < config.CHAT_MAX_TOOL_TURNS; turn++) {
      const stage = turn
        ? "chat.native_tool_turn"
        : "chat.native_tool_selection";
      let message;
      try {
        message = await llm.chat(
          {
            messages,
            // The catalogue is resent although results are already in hand:
            // servers extract tool-call syntax from the output only when the
            // request carries `tools` with `tool_choice: "auto"`. Other
            // combinations return the raw text as content, model-specific
            // tokens included. "none" is not safer — the tool definitions still
            // reach the prompt, while the parser's output is discarded.
            tools: catalogue,
            toolChoice: "auto",
          },
          llmOptions(stage, budget),
        );
      } catch (error) {
        // Only the first turn may degrade to the planner path: once results are
        // in hand, degrading would re-run tools already billed. A later turn's
        // failure fails the chat, as it did before the loop existed.
        if (!turn && isCapabilityError(error, NATIVE_TOOL_FEATURE)) {
          // Cached for the life of the process: re-probing a backend without
          // tool calling costs one paid round trip per request for the same
          // result.
          llm.disableNativeTools();
          return null;
        }
        throw error;
      }

      const calls = message.tool_calls;
      if (!calls?.length || !calls.every((call) => call.type === "function")) {
        // No further calls: this reply is the answer, if it is usable.
        if (allSources.length && usableAnswer(message.content)) {
          return {
            answer: message.content,
            plans: allPlans,
            sources: allSources,
          };
        }
        // Nothing ran and the model answered in prose. Logged with the reply,
        // because "chose no tool" and "asked the user for an argument it was
        // never given" are the same silent null here.
        log?.info({
          stage,
          turn,
          status: "no_tool_calls",
          reply: message.content?.slice(0, 300),
        });
        if (!allSources.length) return null;
        break;
      }

      const plans = validNativeCalls(calls, input, tools);
      if (!plans) {
        log?.info({
          stage,
          turn,
          status: "rejected",
          calls: calls.map((call) => ({
            name: call.function.name,
            arguments: call.function.arguments.slice(0, 200),
          })),
        });
        if (!allSources.length) return null;
        break;
      }

      // A turn that re-requests a batch already run cannot learn anything new,
      // so it ends the loop instead of burning the remaining turns on it.
      const batch = plans.map(plannedToolKey).sort().join("|");
      if (ranBatches.has(batch)) {
        log?.info({ stage, turn, status: "repeated" });
        break;
      }
      ranBatches.add(batch);

      const sources = await runPlans(
        runTool,
        type,
        plans,
        input,
        tools,
        log,
        "native",
      );
      allPlans.push(...plans);
      allSources.push(...sources);
      // Every tool_call id must be answered, or the next turn is a protocol
      // error rather than a continuation.
      messages.push(
        { role: "assistant", content: message.content, tool_calls: calls },
        ...plans.map((plan, index) => ({
          role: "tool" as const,
          tool_call_id: plan.id,
          content: payloadText(sources[index]!, "text"),
        })),
      );
    }

    if (!allSources.length) return null;

    // Out of turns, or the model kept calling instead of answering. Re-asking in
    // the same shape reproduces it, so compose from the results with no `tools`
    // in the request — leaving no syntax in which to express a call.
    log?.info({
      stage: "chat.native_tool_recompose",
      turns: ranBatches.size,
      tools_run: allPlans.length,
    });
    const answer = await timed(log, "chat.native_tool_recompose", {}, () =>
      llm.complete(
        retrievedAnswerPrompt(
          input,
          faqContext,
          environmentContext,
          allSources.map((source) => payloadText(source, "text")),
        ),
        llmOptions("chat.native_tool_recompose", budget),
      ),
    );
    return { answer, plans: allPlans, sources: allSources };
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
    let toolsUnavailable = false;
    try {
      tools = await timed(log, "chat.mcp_list_tools", {}, () =>
        mcp.listTools(mcpType, input.actor),
      );
    } catch (error) {
      const status =
        error instanceof Error
          ? Number(error.message.match(/\b[1-5]\d{2}\b/)?.[0])
          : undefined;
      // error, not debug: an empty catalogue escalates every question that
      // needed data, and the audit row alone cannot tell that apart from a
      // model that simply chose no tool. Status only — the thrown message
      // embeds the auth token, the question and the job id.
      log?.error({ operation: "tools/list", status });
      toolsUnavailable = true;
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
          (toolsUnavailable
            ? "tools_unavailable"
            : environmentSources.length
              ? "insufficient_context"
              : "no_faq_match"),
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
        !plans.length ||
        !plans.every((plan): plan is PlannedChatTool => plan !== null) ||
        !distinctPlans(plans)
      ) {
        // Same blind spot as the native path: without this an escalation cannot
        // be traced to an empty plan versus one whose required args were absent.
        log?.info({
          stage: "chat.plan",
          status: plans.length ? "rejected" : "no_calls",
          calls: plannerOutput.calls.map((plan) => plan.name),
        });
      }
      if (
        plans.length &&
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
