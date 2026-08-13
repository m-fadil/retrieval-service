import { z } from "zod";

export const IndexRequestSchema = z.object({
  documents: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        source: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1),
});

export const AnswerRequestSchema = z.object({
  question: z.string().min(1),
  limit: z.number().int().positive().max(20).default(5),
});

/**
 * Default cosine cut-off for a retrieval match.
 *
 * Calibrated against the current EMBEDDING_MODEL: verbatim question/document
 * pairs score 0.63-0.88, user paraphrases 0.30-0.78, unrelated questions below
 * 0.21. 0.3 sits in that gap; 0.7 excludes most true matches. Recalibrate on
 * any EMBEDDING_MODEL change. Callers with a known corpus should pass
 * `min_score` explicitly.
 */
export const DEFAULT_MIN_SCORE = 0.3;

export const SearchRequestSchema = AnswerRequestSchema.extend({
  min_score: z.number().min(0).max(1).default(DEFAULT_MIN_SCORE),
  // Restricts matches to one payload `source` (e.g. "frappe_faq"). The
  // collection also holds /index documents, which carry no question/answer, so
  // FAQ callers (dedup, faq_search) must scope or they match non-FAQ points.
  source: z.string().min(1).optional(),
});

export const ChatHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1),
});

/**
 * Wire shape of a chat request, pre-normalization. Separate from
 * `ChatRequestSchema` so `ChatAsyncRequestSchema` extends the same fields
 * rather than re-parsing the body.
 */
const ChatRequestFields = z.object({
  question: z.string().trim().optional(),
  message: z.string().trim().optional(),
  // Recent turns, oldest first. Input to the condense step, which rewrites
  // follow-ups ("Yes", "the first one") into standalone questions before
  // retrieval. Absent means no conversational memory.
  history: z.array(ChatHistoryMessageSchema).max(20).optional(),
  limit: z.number().int().positive().max(20).default(5),
  min_score: z.number().min(0).max(1).default(DEFAULT_MIN_SCORE),
  job_id: z.string().trim().min(1).optional(),
  staff_id: z.string().trim().min(1).optional(),
  job_schedule_id: z.string().trim().min(1).optional(),
  staff_ids: z.array(z.string().trim().min(1)).optional(),
  time_filter: z.string().trim().min(1).optional(),
  include_schedules: z.boolean().optional(),
  type: z.enum(["staff", "manager"]).default("staff"),
  // End-user identity, set by the Frappe caller. Forwarded to the MCP tools as
  // a header so they authorize against the real user rather than the shared
  // service account. Never enters tool args or prompts.
  actor: z.string().trim().min(1).optional(),
});

/**
 * Strips absent optionals instead of carrying them as `undefined`, so tool args
 * and log lines contain only fields the caller sent. Returns null when both
 * `question` and `message` are absent; callers convert that to a Zod issue.
 */
function normalizeChatRequest(input: z.output<typeof ChatRequestFields>) {
  const question = input.question || input.message;
  if (!question) return null;
  return {
    question,
    limit: input.limit,
    min_score: input.min_score,
    ...(input.history?.length ? { history: input.history } : {}),
    ...(input.job_id ? { job_id: input.job_id } : {}),
    ...(input.staff_id ? { staff_id: input.staff_id } : {}),
    ...(input.job_schedule_id
      ? { job_schedule_id: input.job_schedule_id }
      : {}),
    ...(input.staff_ids !== undefined ? { staff_ids: input.staff_ids } : {}),
    ...(input.time_filter ? { time_filter: input.time_filter } : {}),
    ...(input.include_schedules !== undefined
      ? { include_schedules: input.include_schedules }
      : {}),
    type: input.type,
    ...(input.actor ? { actor: input.actor } : {}),
  };
}

const missingQuestionIssue = () => ({
  code: "custom" as const,
  message: "question or message is required",
  path: ["question"],
});

export const ChatRequestSchema = ChatRequestFields.transform(
  (input, context) => {
    const normalized = normalizeChatRequest(input);
    if (!normalized) {
      context.addIssue(missingQuestionIssue());
      return z.NEVER;
    }
    return normalized;
  },
);

/**
 * Correlation envelope for /chat/async, echoed verbatim in the Frappe callback
 * so the caller can match an answer to its dispatch.
 */
export const ChatAsyncEnvelopeSchema = z.object({
  request_id: z.string().trim().min(1),
  session_id: z.string().trim().min(1),
});

/**
 * Single schema for the whole /chat/async body: chat fields plus envelope.
 * One schema per body is the precondition for Fastify validating it at all.
 */
export const ChatAsyncRequestSchema = ChatRequestFields.extend(
  ChatAsyncEnvelopeSchema.shape,
).transform((input, context) => {
  const normalized = normalizeChatRequest(input);
  if (!normalized) {
    context.addIssue(missingQuestionIssue());
    return z.NEVER;
  }
  return {
    ...normalized,
    envelope: {
      request_id: input.request_id,
      session_id: input.session_id,
    },
  };
});

export const QueryRequestSchema = AnswerRequestSchema;

export type IndexRequest = z.infer<typeof IndexRequestSchema>;
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type ChatHistoryMessage = z.infer<typeof ChatHistoryMessageSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatAsyncRequest = z.infer<typeof ChatAsyncRequestSchema>;
/**
 * LLM spend for one chat, summed over every completed completion call
 * (condense, tool selection, replay, planner, compose). Counts come from the
 * provider's `usage` field, not an estimate, and stay zero on backends that
 * omit it. Excludes embedding tokens.
 */
export type ChatUsage = {
  model: string;
  llm_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /**
   * Sub-tallies of the two figures above, from the provider's
   * `prompt_tokens_details` / `completion_tokens_details`. Reasoning tokens
   * bill as output but are absent from the answer, so omitting them understates
   * a reasoning model; cached prompt tokens bill at a discount, so omitting
   * them overstates. Zero on backends reporting neither.
   */
  cached_prompt_tokens: number;
  reasoning_tokens: number;
};

export type ChatResponse<Source = unknown> = {
  answer: string;
  route?: "faq" | "fallback" | "mcp" | "hybrid";
  needs_admin: boolean;
  reason: string;
  tools_used?: string[];
  sources: Source[];
  // Failure detail on a chat error, forwarded so Frappe records it on the audit row.
  error?: string;
  usage?: ChatUsage;
  duration_ms?: number;
};
export type ChatAsyncEnvelope = z.infer<typeof ChatAsyncEnvelopeSchema>;
export type QueryRequest = z.infer<typeof QueryRequestSchema>;
