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
  // Timeouts (ms). Every outbound call must be bounded: a hung upstream
  // otherwise pins a Frappe background worker for the life of the request.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  FRAPPE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  QDRANT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Abuse limits. These endpoints spend money per call (LLM + embeddings),
  // so an unbounded body or request rate is a cost-DoS vector.
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_048_576),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
});

export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * Normalize an OpenAI-compatible base URL: a bare provider root defaults to
 * /v1, an explicit path (e.g. a proxy prefix) is respected as-is.
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
          // Tolerate the common KEY="value" / KEY='value' convention; a
          // quoted API key would otherwise fail auth with the quotes baked in.
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
