import { z } from "zod";

export const FaqSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  category: z.string().optional(),
  enabled: z.boolean().default(true),
  modified: z.string().optional(),
});

export const FaqBulkRequestSchema = z.object({
  items: z
    .array(
      z.discriminatedUnion("op", [
        z.object({ op: z.literal("delete"), id: z.string().min(1) }),
        FaqSchema.extend({ op: z.literal("upsert"), id: z.string().min(1) }),
      ]),
    )
    .min(1),
});

export const FaqReindexRequestSchema = z.object({
  items: z.array(FaqSchema.extend({ id: z.string().min(1) })),
});

/** One turn of the conversation a draft FAQ is distilled from. */
export const FaqTranscriptMessageSchema = z.object({
  sender_type: z.string().trim().min(1),
  message: z.string(),
});

export const FaqGenerateRequestSchema = z.object({
  messages: z.array(FaqTranscriptMessageSchema).min(1).max(200),
});

/** Shape the model is asked to return, validated before it is trusted. */
export const FaqDraftSchema = z.object({
  question: z.string().trim().min(1),
  answer: z.string().trim().min(1),
  is_useful: z.boolean(),
});

export type Faq = z.infer<typeof FaqSchema>;
export type FaqBulkRequest = z.infer<typeof FaqBulkRequestSchema>;
export type FaqReindexRequest = z.infer<typeof FaqReindexRequestSchema>;
export type FaqTranscriptMessage = z.infer<typeof FaqTranscriptMessageSchema>;
export type FaqGenerateRequest = z.infer<typeof FaqGenerateRequestSchema>;
export type FaqDraft = z.infer<typeof FaqDraftSchema>;
/** `is_useful: false` means no FAQ should be created from this conversation. */
export type FaqGenerateResult = FaqDraft;
