import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, openAiBaseURL } from "../src/config.js";

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
      EMBEDDING_API_KEY: "gemini-dev",
      EMBEDDING_MODEL: "gemini-embedding-2",
      LOG_LEVEL: "info",
    },
    {},
  );

  assert.equal(config.PORT, 3000);
  assert.equal(config.QDRANT_COLLECTION, "knowledge_base");
  assert.equal(config.EMBEDDING_MODEL, "gemini-embedding-2");
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
      EMBEDDING_API_KEY: "gemini-dev",
      EMBEDDING_MODEL: "gemini-embedding-2",
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
        EMBEDDING_API_KEY: "gemini-dev",
        EMBEDDING_MODEL: "gemini-embedding-2",
        LOG_LEVEL: "verbose",
      },
      {},
    ),
  );
});

test("loadConfig rejects missing provider env", () => {
  assert.throws(() => loadConfig({ QDRANT_URL: "http://qdrant:6333" }, {}));
});

test("openAiBaseURL defaults bare provider root to v1", () => {
  assert.equal(
    openAiBaseURL({ OPENAI_API_URL: "https://llm.example.test" }),
    "https://llm.example.test/v1",
  );
  assert.equal(
    openAiBaseURL({ OPENAI_API_URL: "https://llm.example.test/v1" }),
    "https://llm.example.test/v1",
  );
});
