import Fastify from "fastify";
import { loadConfig, type AppConfig } from "./config.js";
import { apiKeyGuard, rateLimiter } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { apiRoutes } from "./routes/index.js";
import { faqRoutes } from "./routes/faq.js";
import {
  createChatDispatcher,
  type ChatDispatcher,
} from "./services/dispatch.js";
import { createGeminiEmbedder, type Embedder } from "./services/embeddings.js";
import { createFaqService, type FaqService } from "./services/faq.js";
import { createFrappeClient } from "./services/frappe.js";
import { createQdrantStore, type VectorStore } from "./services/qdrant.js";
import { createRagService, type RagService } from "./services/rag.js";

export interface AppDeps {
  config?: AppConfig;
  embedder?: Embedder;
  store?: VectorStore;
  rag?: RagService;
  faq?: FaqService;
  dispatcher?: ChatDispatcher;
}

export function buildApp(deps: AppDeps = {}) {
  const config = deps.config ?? loadConfig();
  const embedder = deps.embedder ?? createGeminiEmbedder(config);
  const store = deps.store ?? createQdrantStore(config);
  const rag = deps.rag ?? createRagService(config, embedder, store);
  const faq = deps.faq ?? createFaqService(embedder, store);
  const dispatcher =
    deps.dispatcher ?? createChatDispatcher(rag, createFrappeClient(config));
  const app = Fastify({
    bodyLimit: config.MAX_BODY_BYTES,
    logger: {
      level: config.LOG_LEVEL,
      ...(process.env.NODE_ENV === "development"
        ? {
            transport: {
              target: "pino-pretty",
              options: {
                translateTime: "HH:MM:ss Z",
                ignore: "pid,hostname",
                singleLine: true,
              },
            },
          }
        : {}),
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-alpha-actor']",
      ],
    },
  });

  // Registered on the root instance so they apply to every route. Fastify
  // encapsulates hooks added inside a plugin, so a guard registered within a
  // route plugin would only protect that plugin's routes.
  app.addHook("onRequest", apiKeyGuard(config.RETRIEVAL_API_KEY));
  app.addHook(
    "onRequest",
    rateLimiter({
      max: config.RATE_LIMIT_MAX,
      windowMs: config.RATE_LIMIT_WINDOW_MS,
    }),
  );

  app.register(healthRoutes(store));
  app.register(apiRoutes(config, rag, dispatcher));
  app.register(faqRoutes(faq, rag));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = buildApp({ config });

  // Without this, Node as PID 1 dies immediately on SIGTERM and every in-flight
  // request is severed: a rolling deploy would drop answers mid-composition,
  // after the LLM and embedding calls have already been paid for.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      app.close().then(
        () => process.exit(0),
        (error) => {
          app.log.error({ err: error }, "shutdown failed");
          process.exit(1);
        },
      );
    });
  }

  await app.listen({ host: config.HOST, port: config.PORT });
}
