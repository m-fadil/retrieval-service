/**
 * Model-output parsing. All model output arrives as text, including what was
 * requested as JSON, so parsing is defensive throughout: an unparseable reply
 * degrades rather than propagating an exception to the caller.
 */

export const MAX_OPTIONAL_TOOL_CALLS = 3;

export type PlannedChatTool = {
  name: string;
  arguments: Record<string, unknown>;
};

export type PlannerOutput = { calls: PlannedChatTool[] };

/**
 * Tool-call token syntax in the dialects observed leaking into content:
 * DeepSeek's fullwidth-bar tokens (`<｜tool▁calls▁begin｜>`,
 * `<｜｜DSML｜｜tool_calls>`), Llama's `<|python_tag|>`, and the `<tool_call>` tag
 * from Qwen and Hermes.
 *
 * Sending the catalogue on every request is what makes the server extract these
 * rather than pass them through, but tool-call parsers are per-model and ship
 * broken often enough that raw tokens still appear.
 *
 * The fullwidth bar and lower-one-eighth block match only inside a `<…>` run,
 * since the tag names between them vary by provider and model version. Matching
 * them bare misclassifies CJK text, where U+FF5C is ordinary punctuation, and
 * costs an extra LLM call to recompose a valid answer.
 */
export const TOOL_CALL_MARKUP =
  /<[^\n>]{0,120}[｜▁][^\n>]{0,120}>|<\|[^\n|]{0,80}\|>|<\/?tool_call\b/i;

/**
 * Whether a completion is usable as a user-facing answer.
 *
 * Empty content means the model replied with a tool call and no prose; tool
 * markup means it attempted one the provider did not parse. Neither is an
 * answer, and both render identically to the user as an unreadable reply.
 */
export function usableAnswer(
  content: string | null | undefined,
): content is string {
  return (
    typeof content === "string" &&
    content.trim().length > 0 &&
    !TOOL_CALL_MARKUP.test(content)
  );
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function parsePlannerOutput(value: string): PlannerOutput | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isPlainObject(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !Array.isArray(parsed.calls) ||
      parsed.calls.length > MAX_OPTIONAL_TOOL_CALLS
    )
      return null;
    const calls: PlannedChatTool[] = [];
    for (const call of parsed.calls) {
      if (
        !isPlainObject(call) ||
        Object.keys(call).length !== 2 ||
        typeof call.name !== "string" ||
        !call.name ||
        !isPlainObject(call.arguments)
      )
        return null;
      calls.push({ name: call.name, arguments: call.arguments });
    }
    return { calls };
  } catch {
    return null;
  }
}

/**
 * Extracts a JSON object from a model reply, stripping the ```json fences models
 * commonly add. Throws unless the reply is a single JSON object.
 */
export function parseJsonObject(value: string): Record<string, unknown> {
  const unfenced = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("LLM reply did not contain a JSON object");
  }
  const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
  if (!isPlainObject(parsed)) {
    throw new Error("LLM reply was not a JSON object");
  }
  return parsed;
}

function canonicalSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSerialize(
            (value as Record<string, unknown>)[key],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** Identity key for a planned call, used to detect duplicate plans. */
export function plannedToolKey(plan: PlannedChatTool) {
  return `${plan.name}:${canonicalSerialize(plan.arguments)}`;
}
