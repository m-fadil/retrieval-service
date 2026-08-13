import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
} from "openai/resources/chat/completions";
import { openAiBaseURL, type AppConfig } from "../config.js";
import type { ChatUsage } from "../schemas/query.js";
import type { ChatLog, TimedLog } from "../chat/log.js";

/**
 * A Structured Outputs contract: the provider is constrained to emit JSON
 * matching `schema`, as opposed to being asked for JSON in the prompt.
 */
export type JsonSchemaSpec = {
  name: string;
  schema: Record<string, unknown>;
};

export type LlmCallOptions = {
  stage: string;
  log?: ChatLog;
  tally?: ChatUsage;
  signal?: AbortSignal;
};

export type LlmChatParams = {
  messages: ChatCompletionCreateParamsNonStreaming["messages"];
  tools?: ChatCompletionCreateParamsNonStreaming["tools"];
  toolChoice?: "auto";
  jsonSchema?: JsonSchemaSpec;
};

export interface Llm {
  readonly model: string;
  newUsage(): ChatUsage;
  /** Single user prompt in, text out. Throws when the reply carries no text. */
  complete(
    prompt: string,
    options: LlmCallOptions & { jsonSchema?: JsonSchemaSpec },
  ): Promise<string>;
  /** Full message list in, raw reply out. Required by the native tool path. */
  chat(
    params: LlmChatParams,
    options: LlmCallOptions,
  ): Promise<ChatCompletionMessage>;
  /** Whether native tool calling is still eligible on this backend. */
  nativeToolsEnabled(): boolean;
  /** Records that the backend refused native tool calling. */
  disableNativeTools(): void;
}

/**
 * True when a provider rejected a request for an unsupported parameter rather
 * than for its content — an OpenAI-compatible gateway lacking tool calling or
 * Structured Outputs. Matches on message text because the compatible API has no
 * capability discovery and error codes differ per gateway.
 */
export function isCapabilityError(error: unknown, feature: RegExp) {
  return error instanceof Error && feature.test(error.message);
}

export const NATIVE_TOOL_FEATURE =
  /\b(?:tools?|tool_choice|tool calls?|function calls?|unsupported parameter)\b/i;

const JSON_SCHEMA_FEATURE =
  /\b(?:response_format|json_schema|structured outputs?|unsupported parameter)\b/i;

export function createLlm(
  config: Pick<
    AppConfig,
    | "OPENAI_API_URL"
    | "OPENAI_API_KEY"
    | "OPENAI_MODEL"
    | "LLM_TIMEOUT_MS"
    | "LLM_MAX_RETRIES"
    | "LLM_NATIVE_TOOLS"
    | "LLM_JSON_SCHEMA"
  >,
): Llm {
  const client = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
    baseURL: openAiBaseURL(config.OPENAI_API_URL),
    maxRetries: config.LLM_MAX_RETRIES,
    timeout: config.LLM_TIMEOUT_MS,
  });

  // "auto" attempts the feature, then degrades once per process, so a backend
  // lacking it pays one rejection instead of one per request.
  let nativeTools = config.LLM_NATIVE_TOOLS !== "off";
  let jsonSchema = config.LLM_JSON_SCHEMA !== "off";

  function newUsage(): ChatUsage {
    return {
      model: config.OPENAI_MODEL,
      llm_calls: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_prompt_tokens: 0,
      reasoning_tokens: 0,
    };
  }

  /**
   * Adds one call to the tally and logs the provider's billed figures. Logs only
   * reported fields, so an unreported one reads as absent rather than zero.
   */
  function logUsage(
    log: TimedLog,
    stage: string,
    usage: OpenAI.CompletionUsage | undefined,
    tally?: ChatUsage,
  ) {
    const cached = usage?.prompt_tokens_details?.cached_tokens;
    const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
    if (tally) {
      tally.llm_calls += 1;
      tally.prompt_tokens += usage?.prompt_tokens ?? 0;
      tally.completion_tokens += usage?.completion_tokens ?? 0;
      tally.total_tokens += usage?.total_tokens ?? 0;
      tally.cached_prompt_tokens += cached ?? 0;
      tally.reasoning_tokens += reasoning ?? 0;
    }
    const tokens = usage
      ? Object.fromEntries(
          Object.entries({
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            cached_prompt_tokens: cached,
            reasoning_tokens: reasoning,
          }).filter(([, value]) => typeof value === "number"),
        )
      : {};
    log?.info({ stage, usage_available: usage !== undefined, ...tokens });
  }

  function responseFormat(spec: JsonSchemaSpec) {
    return {
      type: "json_schema" as const,
      json_schema: {
        name: spec.name,
        // strict is what makes the JSON shape a constraint rather than a request.
        // Backends that ignore it are covered by defensive parsing downstream.
        strict: true,
        schema: spec.schema,
      },
    };
  }

  async function send(
    params: LlmChatParams,
    options: LlmCallOptions,
    useJsonSchema: boolean,
  ) {
    const completion = await client.chat.completions.create(
      {
        model: config.OPENAI_MODEL,
        messages: params.messages,
        ...(params.tools ? { tools: params.tools } : {}),
        ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
        ...(params.jsonSchema && useJsonSchema
          ? { response_format: responseFormat(params.jsonSchema) }
          : {}),
      },
      options.signal ? { signal: options.signal } : undefined,
    );
    logUsage(options.log, options.stage, completion.usage, options.tally);
    const message = completion.choices[0]?.message;
    if (!message) throw new Error("LLM response carried no choices");
    return message;
  }

  async function chat(params: LlmChatParams, options: LlmCallOptions) {
    const wantsJsonSchema = Boolean(params.jsonSchema) && jsonSchema;
    try {
      return await send(params, options, wantsJsonSchema);
    } catch (error) {
      // A gateway without Structured Outputs must not fail the request: retries
      // once in prompt-only mode, then stops attempting it.
      if (
        wantsJsonSchema &&
        config.LLM_JSON_SCHEMA === "auto" &&
        isCapabilityError(error, JSON_SCHEMA_FEATURE)
      ) {
        jsonSchema = false;
        options.log?.info({
          stage: options.stage,
          status: "json_schema_unsupported",
        });
        return send(params, options, false);
      }
      options.log?.info({ stage: options.stage, status: "error" });
      throw error;
    }
  }

  return {
    model: config.OPENAI_MODEL,
    newUsage,
    chat,
    async complete(prompt, options) {
      const message = await chat(
        {
          messages: [{ role: "user", content: prompt }],
          ...(options.jsonSchema ? { jsonSchema: options.jsonSchema } : {}),
        },
        options,
      );
      if (typeof message.content !== "string")
        throw new Error("LLM response missing content");
      return message.content;
    },
    nativeToolsEnabled: () => nativeTools,
    disableNativeTools() {
      if (config.LLM_NATIVE_TOOLS === "auto") nativeTools = false;
    },
  };
}
