import type { FastifyBaseLogger } from "fastify";
import type { ChatUsage } from "../schemas/query.js";

export type ChatLog = Pick<FastifyBaseLogger, "debug" | "info" | "error">;
export type TimedLog = ChatLog | undefined;

/**
 * Carries the usage tally on a failed chat: calls completed before the failure
 * are billed, and the dispatcher forwards their cost to the audit log rather
 * than reporting the most expensive failures as zero spend.
 */
export class ChatFailedError extends Error {
  constructor(
    cause: unknown,
    readonly usage: ChatUsage,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ChatFailedError";
  }
}

/** Raised when the whole-request deadline expires mid-flow. */
export class ChatDeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`chat exceeded its ${deadlineMs}ms deadline`);
    this.name = "ChatDeadlineError";
  }
}

export async function timed<T>(
  log: TimedLog,
  stage: string,
  details: Record<string, unknown>,
  work: () => Promise<T>,
) {
  const start = performance.now();
  try {
    const result = await work();
    log?.info({ stage, ms: Math.round(performance.now() - start), ...details });
    return result;
  } catch (error) {
    log?.error({
      stage,
      ms: Math.round(performance.now() - start),
      err: error,
      ...details,
    });
    throw error;
  }
}
