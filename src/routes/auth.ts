import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Routes reachable without the shared API key: the probes a container runtime
 * and a load balancer issue before any credential is available to them. Keep
 * minimal — each entry is an unauthenticated surface.
 */
const PUBLIC_PATHS = new Set(["/health", "/health/live", "/health/ready"]);

export function isPublicPath(url: string) {
  return PUBLIC_PATHS.has(new URL(url, "http://localhost").pathname);
}

export function httpError(statusCode: number, message: string) {
  const error = new Error(message);
  Object.assign(error, { statusCode });
  return error;
}

function constantTimeEquals(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, so length is compared outside
  // it. Leaking the expected key's length is acceptable; its bytes are not.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Rejects any request that does not carry the shared API key.
 *
 * Must stay an onRequest hook on the root instance: Fastify encapsulates hooks
 * per plugin, so a guard registered inside a route plugin covers only that
 * plugin's routes. On the root instance it covers routes added later too.
 */
export function apiKeyGuard(apiKey: string) {
  const expected = `Bearer ${apiKey}`;
  return async function guard(request: FastifyRequest) {
    if (isPublicPath(request.url)) return;
    const provided = request.headers.authorization;
    if (
      typeof provided !== "string" ||
      !constantTimeEquals(provided, expected)
    ) {
      throw httpError(401, "Unauthorized");
    }
  };
}

/**
 * Matches the FAQ synchronisation paths: the writes Frappe doc_events drive,
 * one call per FAQ row.
 *
 * Excludes `/faq/generate`, which costs an LLM call per request and is
 * user-initiated, so it belongs on the ordinary per-actor budget.
 */
export function isFaqSyncPath(url: string) {
  const { pathname } = new URL(url, "http://localhost");
  return pathname.startsWith("/faq/") && pathname !== "/faq/generate";
}

/**
 * The bucket a request counts against.
 *
 * Keyed on `actor`, not the client address: all chat traffic originates from one
 * Frappe server, so an address key yields a single global bucket where one
 * member exhausts everyone's budget. `actor` lives in the body, hence the
 * preValidation hook — after body parsing, before any paid call.
 *
 * The value is untrusted input used only as a cache key, so it is length-capped;
 * requests without one fall back to the address.
 *
 * FAQ sync takes a distinct key rather than that shared address bucket, making
 * the two budgets independent in both directions.
 */
export function rateLimitKey(request: FastifyRequest) {
  if (isFaqSyncPath(request.url)) return `faq:${request.ip}`;
  const actor = (request.body as { actor?: unknown } | undefined)?.actor;
  return typeof actor === "string" && actor.length <= 128
    ? `actor:${actor}`
    : `ip:${request.ip}`;
}

/**
 * Per-bucket ceiling. Two budgets because the traffic differs by an order of
 * magnitude: a few questions per minute per actor, versus one write per row for
 * a whole FAQ import.
 */
export function rateLimitMax(config: {
  RATE_LIMIT_MAX: number;
  FAQ_RATE_LIMIT_MAX: number;
}) {
  return (request: FastifyRequest) =>
    isFaqSyncPath(request.url)
      ? config.FAQ_RATE_LIMIT_MAX
      : config.RATE_LIMIT_MAX;
}
