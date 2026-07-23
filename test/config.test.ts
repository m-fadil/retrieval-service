import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, openAiBaseURL, readDotEnv } from "../src/config.js";

test("loadConfig validates and defaults env", () => {
  const config = loadConfig(
    {
      QDRANT_URL: "http://qdrant:6333",
      FRAPPE_URL: "http://localhost:8000",
      FRAPPE_AUTH_TOKEN: "token dev",
      RETRIEVAL_API_KEY: "retrieval-dev",
      OPENAI_API_URL: "https://llm.example.test",
      OPENAI_API_KEY: "sk-dev",
      OPENAI_MODEL: "large",
      EMBEDDING_API_URL: "https://embed.example.test",
      EMBEDDING_API_KEY: "embed-dev",
      EMBEDDING_MODEL: "text-embedding-3-small",
      LOG_LEVEL: "info",
    },
    {},
  );

  assert.equal(config.PORT, 3000);
  assert.equal(config.QDRANT_COLLECTION, "knowledge_base");
  assert.equal(config.EMBEDDING_MODEL, "text-embedding-3-small");
  assert.equal(config.LOG_LEVEL, "info");
});

test("loadConfig accepts debug LOG_LEVEL from dotenv input", () => {
  const config = loadConfig(
    {
      QDRANT_URL: "http://qdrant:6333",
      FRAPPE_URL: "http://localhost:8000",
      FRAPPE_AUTH_TOKEN: "token dev",
      RETRIEVAL_API_KEY: "retrieval-dev",
      OPENAI_API_URL: "https://llm.example.test",
      OPENAI_API_KEY: "sk-dev",
      OPENAI_MODEL: "large",
      EMBEDDING_API_URL: "https://embed.example.test",
      EMBEDDING_API_KEY: "embed-dev",
      EMBEDDING_MODEL: "text-embedding-3-small",
    },
    { LOG_LEVEL: "debug" },
  );

  assert.equal(config.LOG_LEVEL, "debug");
});

test("loadConfig rejects invalid LOG_LEVEL", () => {
  assert.throws(() =>
    loadConfig(
      {
        QDRANT_URL: "http://qdrant:6333",
        FRAPPE_URL: "http://localhost:8000",
        FRAPPE_AUTH_TOKEN: "token dev",
        RETRIEVAL_API_KEY: "retrieval-dev",
        OPENAI_API_URL: "https://llm.example.test",
        OPENAI_API_KEY: "sk-dev",
        OPENAI_MODEL: "large",
        EMBEDDING_API_URL: "https://embed.example.test",
        EMBEDDING_API_KEY: "embed-dev",
        EMBEDDING_MODEL: "text-embedding-3-small",
        LOG_LEVEL: "verbose",
      },
      {},
    ),
  );
});

test("loadConfig rejects missing provider env", () => {
  assert.throws(() => loadConfig({ QDRANT_URL: "http://qdrant:6333" }, {}));
});

test("readDotEnv strips matching surrounding quotes from values", () => {
  const path = join(mkdtempSync(join(tmpdir(), "dotenv-")), ".env");
  writeFileSync(
    path,
    [
      'DOUBLE="secret-key"',
      "SINGLE='another'",
      "BARE=plain",
      'UNMATCHED="half',
      'EMBEDDED=ab"cd"ef',
    ].join("\n"),
  );

  assert.deepEqual(readDotEnv(path), {
    DOUBLE: "secret-key",
    SINGLE: "another",
    BARE: "plain",
    UNMATCHED: '"half',
    EMBEDDED: 'ab"cd"ef',
  });
});

test("openAiBaseURL defaults bare provider root to v1", () => {
  assert.equal(
    openAiBaseURL("https://llm.example.test"),
    "https://llm.example.test/v1",
  );
  assert.equal(
    openAiBaseURL("https://llm.example.test/v1"),
    "https://llm.example.test/v1",
  );
  // A custom path (e.g. OpenRouter's /api/v1) is respected as-is.
  assert.equal(
    openAiBaseURL("https://openrouter.ai/api/v1"),
    "https://openrouter.ai/api/v1",
  );
});
