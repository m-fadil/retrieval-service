import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const BooleanEnvSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const LogLevelSchema = z.enum([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
]);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  QDRANT_URL: z.url(),
  QDRANT_COLLECTION: z.string().default("knowledge_base"),
  QDRANT_API_KEY: z.string().optional(),
  FRAPPE_URL: z.url(),
  FRAPPE_AUTH_TOKEN: z.string().min(1),
  RETRIEVAL_API_KEY: z.string().min(1),
  OPENAI_API_URL: z.url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1),
  EMBEDDING_API_URL: z.url(),
  EMBEDDING_API_KEY: z.string().min(1),
  EMBEDDING_MODEL: z.string().min(1),
  LOG_CHAT_REQUEST_BODY: BooleanEnvSchema,
  LOG_LEVEL: LogLevelSchema.default("info"),
  // Makes Fastify read X-Forwarded-For as `request.ip`. Off, every rate-limit
  // bucket behind a proxy collapses into the proxy's address; on, an untrusted
  // client can forge its own bucket key. Enable only where the proxy overwrites
  // the header.
  TRUST_PROXY: BooleanEnvSchema,
  // One sentence naming what the assistant covers, e.g. "staff and manager
  // questions about jobs, shifts, schedules and payroll at Alpha Fitness".
  // Read only by the triage step, which needs an in-scope boundary to separate
  // a conversational turn from a question the assistant cannot serve. Empty
  // falls back to inferring scope from the tool catalogue and FAQ excerpts.
  ASSISTANT_SCOPE: z.string().trim().default(""),
  // Timeouts (ms). Every outbound call is bounded: an unbounded one pins a
  // Frappe background worker for as long as the upstream hangs.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  // Ceiling on one whole /chat, across all its LLM, MCP and embedding calls.
  // Per-call timeouts do not bound the flow: six sequential LLM calls, each
  // retried LLM_MAX_RETRIES times, compound into minutes. On expiry the
  // in-flight calls are aborted and the question is escalated.
  //
  // Invariant: below the caller's timeout, which is 90s in Frappe (CHAT_TIMEOUT
  // in alpha_fitness/integrations/retrieval_faq.py). Above it, the caller has
  // already disconnected while this side keeps billing tokens. Raise only in
  // step with the caller.
  CHAT_DEADLINE_MS: z.coerce.number().int().positive().default(75_000),
  // Tool-calling rounds per chat. One round cannot answer a question whose
  // second call depends on the first one's result; every extra round is a paid
  // LLM call, so the ceiling is a cost knob, not a correctness one.
  CHAT_MAX_TOOL_TURNS: z.coerce.number().int().min(1).max(10).default(3),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  EMBEDDING_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  // Texts per embeddings request. The API accepts an array, so indexing and
  // reindexing batch rather than issuing one HTTP call per FAQ entry.
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().max(512).default(64),
  FRAPPE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  QDRANT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Abuse limits. These endpoints bill per call (LLM + embeddings), so an
  // unbounded body size or request rate is a cost-DoS vector.
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_048_576),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Separate, larger budget for the FAQ sync paths. They carry no `actor`, so
  // they share one address bucket, and Frappe doc_events call them once per FAQ
  // row: a bulk import exceeds RATE_LIMIT_MAX mid-run and the 429 surfaces as a
  // failed doc_event, not a deferred one. Bounded regardless, since content_hash
  // skips unchanged rows before the embedding call.
  FAQ_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  // Background /chat/async work. Each accepted job costs three to six LLM
  // calls, so an unbounded burst fans out into hundreds of concurrent paid
  // calls. Jobs past MAX_CONCURRENT queue; jobs past MAX_QUEUED get 503, which
  // the caller can retry — as opposed to a 202 whose work is then dropped.
  CHAT_ASYNC_MAX_CONCURRENT: z.coerce.number().int().positive().default(8),
  CHAT_ASYNC_MAX_QUEUED: z.coerce.number().int().positive().default(64),
  // Negotiation mode for provider features that not every OpenAI-compatible
  // backend implements: "auto" probes once and caches a rejection for the life
  // of the process, "on" requires the feature, "off" never attempts it.
  //
  // LLM_NATIVE_TOOLS selects provider-parsed tool calls vs the JSON planner
  // fallback; LLM_JSON_SCHEMA selects Structured Outputs (response_format
  // json_schema, strict) vs asking for JSON in the prompt.
  LLM_NATIVE_TOOLS: z.enum(["auto", "on", "off"]).default("auto"),
  LLM_JSON_SCHEMA: z.enum(["auto", "on", "off"]).default("auto"),
  // Page ceiling for tools/list pagination: bounds a server that returns a
  // cursor indefinitely.
  MCP_MAX_TOOL_PAGES: z.coerce.number().int().positive().max(100).default(20),
});

export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * Normalizes an OpenAI-compatible base URL: a bare root gets /v1, an explicit
 * path (e.g. a proxy prefix) is preserved.
 */
export function openAiBaseURL(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.pathname === "/") url.pathname = "/v1";
  return url.toString().replace(/\/$/, "");
}

export function readDotEnv(
  path = resolve(process.cwd(), ".env"),
): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const index = line.indexOf("=");
          if (index === -1) return [line, ""];
          // Strips the KEY="value" / KEY='value' convention: retained quotes
          // become part of the value and fail auth.
          const raw = line.slice(index + 1).trim();
          const value = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
          return [line.slice(0, index), value];
        }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  dotEnv = readDotEnv(),
): AppConfig {
  return EnvSchema.parse({ ...dotEnv, ...env });
}
