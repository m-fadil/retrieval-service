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

export const SearchRequestSchema = AnswerRequestSchema.extend({
  min_score: z.number().min(0).max(1).default(0.7),
});

export const ChatRequestSchema = z
  .object({
    question: z.string().trim().optional(),
    message: z.string().trim().optional(),
    limit: z.number().int().positive().max(20).default(5),
    min_score: z.number().min(0).max(1).default(0.7),
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
export const QueryRequestSchema = AnswerRequestSchema;

export type IndexRequest = z.infer<typeof IndexRequestSchema>;
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatResponse<Source = unknown> = {
  answer: string;
  route?: "faq" | "fallback" | "mcp" | "hybrid";
  needs_admin: boolean;
  reason: string;
  tools_used?: string[];
  sources: Source[];
};
export type QueryRequest = z.infer<typeof QueryRequestSchema>;
