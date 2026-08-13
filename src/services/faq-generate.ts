import { z } from "zod";
import {
  FaqDraftSchema,
  type FaqGenerateRequest,
  type FaqGenerateResult,
} from "../schemas/faq.js";
import type { ChatLog } from "../chat/log.js";
import { parseJsonObject } from "../chat/parse.js";
import { FAQ_DRAFT_JSON_SCHEMA, faqGeneratePrompt } from "../chat/prompts.js";
import type { Llm } from "./llm.js";

/**
 * Distils a support conversation into a draft FAQ entry.
 *
 * Placed in this service, not the Frappe app, to keep the model choice and prompt
 * in one place. The caller receives validated fields only.
 */
export function createFaqGenerator(llm: Llm) {
  return async function generateFaq(
    input: FaqGenerateRequest,
    log?: ChatLog,
  ): Promise<FaqGenerateResult> {
    const conversation = input.messages
      .map((message) => {
        const label =
          message.sender_type === "User" ? "Customer" : message.sender_type;
        return `${label}: ${message.message}`;
      })
      .join("\n");

    const raw = await llm.complete(faqGeneratePrompt(conversation), {
      stage: "faq.generate",
      log,
      jsonSchema: FAQ_DRAFT_JSON_SCHEMA,
    });

    try {
      return FaqDraftSchema.parse(parseJsonObject(raw));
    } catch (error) {
      // An off-shape model reply is an upstream failure, not a bad request: a
      // ZodError escaping here would be rendered 400 by the request-validation
      // error handler.
      throw new Error(
        `LLM reply did not match the FAQ draft shape: ${
          error instanceof z.ZodError
            ? error.issues.map((issue) => issue.message).join("; ")
            : String(error)
        }`,
        { cause: error },
      );
    }
  };
}
