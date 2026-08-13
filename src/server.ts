import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { loadConfig, type AppConfig } from "./config.js";
import {
  apiKeyGuard,
  isPublicPath,
  rateLimitKey,
  rateLimitMax,
} from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { apiRoutes } from "./routes/index.js";
import { faqRoutes } from "./routes/faq.js";
import { zodErrorHandler, zodValidatorCompiler } from "./plugins/zod.js";
import {
  createChatDispatcher,
  type ChatDispatcher,
} from "./services/dispatch.js";
import { createOpenAiEmbedder, type Embedder } from "./services/embeddings.js";
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
  const embedder = deps.embedder ?? createOpenAiEmbedder(config);
  const store = deps.store ?? createQdrantStore(config);
  const rag = deps.rag ?? createRagService(config, embedder, store);
  const faq =
    deps.faq ?? createFaqService(embedder, store, config.EMBEDDING_BATCH_SIZE);
  const dispatcher =
    deps.dispatcher ??
    createChatDispatcher(rag, createFrappeClient(config), undefined, {
      maxConcurrent: config.CHAT_ASYNC_MAX_CONCURRENT,
      maxQueued: config.CHAT_ASYNC_MAX_QUEUED,
    });
  const app = Fastify({
    bodyLimit: config.MAX_BODY_BYTES,
    // Off by default: on, an untrusted client forges its own X-Forwarded-For
    // and therefore its own rate-limit bucket. Requires a proxy that overwrites
    // the header.
    trustProxy: config.TRUST_PROXY,
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

  // Validates bodies and path params inside Fastify's pipeline, making
  // malformed input a 400 before the handler runs.
  app.setValidatorCompiler(zodValidatorCompiler);
  zodErrorHandler(app);

  // Root instance, so it covers every route including later ones — Fastify
  // encapsulates hooks per plugin.
  app.addHook("onRequest", apiKeyGuard(config.RETRIEVAL_API_KEY));

  // Cost guard ahead of paid LLM/embedding calls, not a distributed quota: the
  // store is in-process, so with N replicas the effective limit is the
  // per-bucket ceiling times N. See DESIGN.md §7. Two ceilings — see
  // rateLimitKey and rateLimitMax.
  app.register(rateLimit, {
    global: true,
    max: rateLimitMax(config),
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    // preValidation, not onRequest: the key comes from the body, which is not
    // parsed at onRequest. Still precedes validation, so malformed bodies count
    // against the budget.
    hook: "preValidation",
    keyGenerator: rateLimitKey,
    allowList: (request) => isPublicPath(request.url),
  });

  app.register(healthRoutes(store));
  app.register(apiRoutes(config, rag, dispatcher));
  app.register(faqRoutes(faq, rag));

  // Accepted /chat/async jobs outlive their request, so server close must drain
  // them: otherwise a rolling deploy discards work whose LLM and embedding
  // calls are already billed.
  app.addHook("onClose", async () => {
    if (dispatcher.pending()) {
      app.log.info(
        { pending: dispatcher.pending() },
        "draining background chat jobs",
      );
    }
    await dispatcher.drain();
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = buildApp({ config });

  // Node as PID 1 has no default SIGTERM handler, so without these it exits
  // immediately and severs every in-flight request — dropping answers
  // mid-composition, after their LLM and embedding calls are billed.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      // app.close() runs the onClose hook, which drains the background jobs.
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
