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
 * Default cosine cut-off for a match worth answering from.
 *
 * Not 0.7, which is the figure that looks right and that no query reaches:
 * cosine scores are a property of the embedding model, and against the model
 * in use a question typed word for word the same as an indexed document
 * scores 0.63-0.88, while the paraphrases real users write score 0.30-0.78.
 * A 0.7 default filtered out most true matches and reported "no match" for
 * documents that plainly answered the question. Unrelated questions score
 * below 0.21 against the same index, which is the margin this relies on.
 *
 * Callers that know their own corpus should send `min_score` explicitly;
 * recalibrate this whenever EMBEDDING_MODEL changes.
 */
export const DEFAULT_MIN_SCORE = 0.3;

export const SearchRequestSchema = AnswerRequestSchema.extend({
  min_score: z.number().min(0).max(1).default(DEFAULT_MIN_SCORE),
  // Restricts matches to one payload `source` (e.g. "frappe_faq"). The
  // collection is shared with /index documents, so FAQ-oriented callers —
  // dedup and the faq_search MCP tool — must scope their searches or non-FAQ
  // points surface as matches with no question/answer.
  source: z.string().min(1).optional(),
});

export const ChatHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1),
});

export const ChatRequestSchema = z
  .object({
    question: z.string().trim().optional(),
    message: z.string().trim().optional(),
    // Recent conversation turns, oldest first, sent by the Frappe caller.
    // Lets follow-ups ("Yes", "the first one") be condensed into standalone
    // questions before retrieval; without them the service has no memory.
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
    // End-user identity, set server-side by the Frappe caller. Forwarded to
    // the MCP tools so they can authorize against the real user instead of
    // the shared service account. Never placed into tool args or prompts.
    actor: z.string().trim().min(1).optional(),
  })
  .transform((input, context) => {
    const question = input.question || input.message;
    if (!question) {
      context.addIssue({
        code: "custom",
        message: "question or message is required",
        path: ["question"],
      });
      return z.NEVER;
    }
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
  });
/**
 * Correlation envelope for /chat/async. Parsed alongside ChatRequestSchema
 * (which strips these unknown keys) rather than folded into its transform.
 * Echoed back verbatim in the Frappe callback so the caller can match the
 * answer to the dispatch that asked the question.
 */
export const ChatAsyncEnvelopeSchema = z.object({
  request_id: z.string().trim().min(1),
  session_id: z.string().trim().min(1),
});

export const QueryRequestSchema = AnswerRequestSchema;

export type IndexRequest = z.infer<typeof IndexRequestSchema>;
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type ChatHistoryMessage = z.infer<typeof ChatHistoryMessageSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
/**
 * LLM spend for one chat, summed across every completed completion call
 * (condense, tool selection, replay, planner, compose). Token counts come from
 * the provider's own `usage` field — the billing numbers, not an estimate —
 * and stay zero for calls whose backend does not report usage. Embedding
 * tokens are not included.
 */
export type ChatUsage = {
  model: string;
  llm_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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
