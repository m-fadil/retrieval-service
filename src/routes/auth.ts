import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Routes reachable without the shared API key. Keep this list minimal. */
const PUBLIC_PATHS = new Set(["/health"]);

export function httpError(statusCode: number, message: string) {
  const error = new Error(message);
  Object.assign(error, { statusCode });
  return error;
}

function constantTimeEquals(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, so compare lengths separately.
  // The length of the expected key is not secret.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Rejects any request that does not carry the shared API key.
 *
 * Registered as an onRequest hook on the root instance so it covers every
 * route, including ones added later. Previously each route plugin was
 * responsible for its own guard, which meant /chat, /search, /index, /answer
 * and /query were reachable unauthenticated.
 */
export function apiKeyGuard(apiKey: string) {
  const expected = `Bearer ${apiKey}`;
  return async function guard(request: FastifyRequest) {
    if (PUBLIC_PATHS.has(new URL(request.url, "http://localhost").pathname)) {
      return;
    }
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
 * Fixed-window rate limiter keyed by client address.
 *
 * Deliberately dependency-free and in-process: it is a cost guard in front of
 * paid LLM/embedding calls, not a distributed quota. With more than one replica
 * the effective limit is RATE_LIMIT_MAX per replica.
 *
 * All Frappe traffic arrives from the Frappe server's address, so every chat
 * user shares that one bucket: size RATE_LIMIT_MAX for aggregate chat load,
 * not per-user rates.
 */
export function rateLimiter(options: { max: number; windowMs: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return async function limit(request: FastifyRequest, reply: FastifyReply) {
    if (PUBLIC_PATHS.has(new URL(request.url, "http://localhost").pathname)) {
      return;
    }
    const now = Date.now();
    const key = request.ip;
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      // Opportunistically evict expired keys so the map cannot grow without
      // bound under a rotating set of source addresses.
      for (const [candidate, value] of hits) {
        if (value.resetAt <= now) hits.delete(candidate);
      }
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
      return;
    }

    entry.count += 1;
    if (entry.count > options.max) {
      reply.header("retry-after", Math.ceil((entry.resetAt - now) / 1000));
      throw httpError(429, "Too Many Requests");
    }
  };
}
