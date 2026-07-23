import type {
  ChatAsyncEnvelope,
  ChatRequest,
  ChatResponse,
} from "../schemas/query.js";
import type { FrappeClient } from "./frappe.js";
import type { SearchHit } from "./qdrant.js";
import type { ChatLog, RagService } from "./rag.js";

/**
 * Where the final answer lands. Fixed rather than caller-supplied: accepting a
 * callback URL or method name in the request would let anyone holding the API
 * key aim authenticated Frappe calls at arbitrary methods.
 */
export const CHAT_CALLBACK_METHOD =
  "alpha_fitness.api.chat.ai_response_callback";

/** ~31s of retries; anything beyond that is the Frappe-side sweep's problem. */
const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 25_000];

export interface ChatDispatcher {
  /**
   * Runs the full chat flow in the background and delivers the result to
   * Frappe. Returns the background promise so tests can await completion;
   * the route deliberately does not.
   */
  dispatch(
    input: ChatRequest,
    envelope: ChatAsyncEnvelope,
    log?: ChatLog,
  ): Promise<void>;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createChatDispatcher(
  rag: Pick<RagService, "chat">,
  frappe: FrappeClient,
  retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
): ChatDispatcher {
  async function deliver(
    payload: Record<string, unknown>,
    log?: ChatLog,
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(retryDelaysMs[attempt - 1]!);
      try {
        await frappe.call(CHAT_CALLBACK_METHOD, payload);
        return true;
      } catch (error) {
        log?.error(
          { err: error, attempt, request_id: payload.request_id },
          "chat callback delivery failed",
        );
      }
    }
    // The user is not left hanging forever: the Frappe stale sweep escalates
    // sessions whose claim was never consumed.
    log?.error(
      { request_id: payload.request_id },
      "chat callback abandoned after retries",
    );
    return false;
  }

  return {
    async dispatch(input, envelope, log) {
      // Measured here rather than taken from the chat response so a failed
      // chat still reports how long it burned before escalating.
      const started = performance.now();
      let response: ChatResponse<SearchHit>;
      try {
        response = await rag.chat(input, log);
      } catch (error) {
        // The callback must go out even when chat fails, so the question is
        // escalated to an admin instead of silently waiting out the sweep.
        log?.error(
          { err: error, request_id: envelope.request_id },
          "async chat failed",
        );
        response = {
          answer: "",
          route: "fallback",
          needs_admin: true,
          reason: "chat_failed",
          tools_used: [],
          sources: [],
        };
      }

      await deliver(
        {
          session_id: envelope.session_id,
          request_id: envelope.request_id,
          question: input.question,
          answer: response.answer,
          route: response.route,
          reason: response.reason,
          needs_admin: response.needs_admin,
          tools_used: response.tools_used ?? [],
          // Ids only: the payloads carry FAQ text and tool output the
          // callback has no use for.
          sources: (response.sources ?? []).map((source) => ({
            id: source.id,
          })),
          // Cost accounting for the audit log; absent when chat failed
          // before any LLM call completed.
          ...(response.usage ? { usage: response.usage } : {}),
          duration_ms: Math.round(performance.now() - started),
        },
        log,
      );
    },
  };
}
