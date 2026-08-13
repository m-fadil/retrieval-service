import type {
  ChatAsyncEnvelope,
  ChatRequest,
  ChatResponse,
} from "../schemas/query.js";
import type { FrappeClient } from "./frappe.js";
import type { SearchHit } from "./qdrant.js";
import { ChatFailedError, type ChatLog, type RagService } from "./rag.js";

/**
 * Callback target for the final answer. Hardcoded, not caller-supplied: a URL or
 * method name from the request would let any API-key holder direct
 * authenticated Frappe calls at arbitrary methods.
 */
export const CHAT_CALLBACK_METHOD =
  "alpha_fitness.api.chat.ai_response_callback";

/** ~31s of retries total; past that the Frappe-side stale sweep takes over. */
const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 25_000];

export interface ChatDispatcher {
  /**
   * Runs the chat flow in the background and delivers the result to Frappe.
   * Returns the background promise for tests to await; the route does not await
   * it.
   */
  dispatch(
    input: ChatRequest,
    envelope: ChatAsyncEnvelope,
    log?: ChatLog,
  ): Promise<void>;
  /**
   * Whether there is room for another job. The route checks this synchronously
   * so a full queue is refused while the caller is still listening: a job
   * accepted with 202 and then dropped leaves the member awaiting an answer that
   * never arrives.
   */
  accepts(): boolean;
  /** Jobs running or waiting for a slot. */
  pending(): number;
  /**
   * Resolves once every accepted job has delivered its callback. Awaited on
   * shutdown; unawaited, SIGTERM discards jobs whose LLM calls are already
   * billed and the member waits out the Frappe stale sweep.
   */
  drain(): Promise<void>;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ChatDispatcherOptions = {
  /** Concurrent job ceiling. Each job costs three to six paid LLM calls. */
  maxConcurrent?: number;
  /** Queue depth for accepted jobs before the route refuses further ones. */
  maxQueued?: number;
};

export function createChatDispatcher(
  rag: Pick<RagService, "chat">,
  frappe: FrappeClient,
  retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
  options: ChatDispatcherOptions = {},
): ChatDispatcher {
  const maxConcurrent = options.maxConcurrent ?? 8;
  const maxQueued = options.maxQueued ?? 64;
  let running = 0;
  let queued = 0;
  const waiting: Array<() => void> = [];
  const inFlight = new Set<Promise<void>>();

  /** Fixed-size semaphore, FIFO: the oldest queued question runs first. */
  async function acquire() {
    if (running < maxConcurrent) {
      running += 1;
      return;
    }
    queued += 1;
    try {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } finally {
      queued -= 1;
    }
    running += 1;
  }

  function release() {
    running -= 1;
    waiting.shift()?.();
  }

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
    // Not a permanent hang: the Frappe stale sweep escalates sessions whose
    // claim was never consumed.
    log?.error(
      { request_id: payload.request_id },
      "chat callback abandoned after retries",
    );
    return false;
  }

  async function run(
    input: ChatRequest,
    envelope: ChatAsyncEnvelope,
    log?: ChatLog,
  ) {
    // Measured here, not read from the chat response, so a failed chat still
    // reports its elapsed time.
    const started = performance.now();
    let response: ChatResponse<SearchHit>;
    try {
      response = await rag.chat(input, log);
    } catch (error) {
      // The callback fires on failure too, escalating to an admin rather than
      // leaving the session for the sweep.
      log?.error(
        { err: error, request_id: envelope.request_id },
        "async chat failed",
      );
      response = {
        answer: "",
        route: "fallback",
        needs_admin: true,
        reason: "chat_failed",
        // Forwarded for the Frappe audit row.
        error: error instanceof Error ? error.message : String(error),
        tools_used: [],
        sources: [],
        // Calls completed before the failure are still billed, so their tally
        // travels with the error.
        ...(error instanceof ChatFailedError ? { usage: error.usage } : {}),
      };
    }

    await deliver(
      {
        session_id: envelope.session_id,
        request_id: envelope.request_id,
        // No question text: Frappe's audit log strips text keys, so sending it
        // would be a round trip with no reader.
        answer: response.answer,
        route: response.route,
        reason: response.reason,
        needs_admin: response.needs_admin,
        // Failures only; Frappe records the cause.
        ...(response.error ? { error: response.error } : {}),
        tools_used: response.tools_used ?? [],
        // Ids only — the payloads carry FAQ text and tool output no consumer
        // of this callback reads.
        sources: (response.sources ?? []).map((source) => ({
          id: source.id,
        })),
        // Cost accounting for the audit log. Present on failures as a partial
        // tally; absent only when the chat reports no usage at all.
        ...(response.usage ? { usage: response.usage } : {}),
        duration_ms: Math.round(performance.now() - started),
      },
      log,
    );
  }

  return {
    accepts: () => queued < maxQueued,
    pending: () => running + queued,
    async drain() {
      // Queued jobs start as running ones finish, so the set must be re-read
      // until empty rather than awaited once.
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
    async dispatch(input, envelope, log) {
      await acquire();
      const job = run(input, envelope, log).finally(release);
      inFlight.add(job);
      try {
        await job;
      } finally {
        inFlight.delete(job);
      }
    },
  };
}
