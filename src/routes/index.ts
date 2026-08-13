import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.js";
import type { ZodTypeProvider } from "../plugins/zod.js";
import {
  AnswerRequestSchema,
  ChatAsyncRequestSchema,
  ChatRequestSchema,
  IndexRequestSchema,
  QueryRequestSchema,
  SearchRequestSchema,
} from "../schemas/query.js";
import { httpError } from "./auth.js";
import type { ChatDispatcher } from "../services/dispatch.js";
import type { RagService } from "../services/rag.js";

/**
 * Fastify validates bodies against the Zod schemas below, so malformed requests
 * get a 400 before any handler and before any paid call. Handlers receive
 * `request.body` parsed and typed.
 */
export function apiRoutes(
  config: Pick<AppConfig, "LOG_CHAT_REQUEST_BODY">,
  rag: RagService,
  dispatcher: ChatDispatcher,
): FastifyPluginAsync {
  return async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();

    app.post("/index", { schema: { body: IndexRequestSchema } }, (request) =>
      rag.index(request.body),
    );

    app.post("/search", { schema: { body: SearchRequestSchema } }, (request) =>
      rag.search(request.body),
    );

    app.post("/answer", { schema: { body: AnswerRequestSchema } }, (request) =>
      rag.answer(request.body, request.log),
    );

    // Accepts and returns immediately; the dispatcher delivers the answer to
    // Frappe, so no caller-side worker blocks on the LLM.
    app.post(
      "/chat/async",
      { schema: { body: ChatAsyncRequestSchema } },
      async (request, reply) => {
        const { envelope, ...input } = request.body;
        if (config.LOG_CHAT_REQUEST_BODY) {
          request.log.info({ stage: "chat.request", body: input });
        }
        // Refused while the caller is still listening: a 202 for a job that never
        // runs is an answer that never arrives.
        if (!dispatcher.accepts()) {
          request.log.error({
            stage: "chat.async_rejected",
            pending: dispatcher.pending(),
            request_id: envelope.request_id,
          });
          throw httpError(503, "Chat backlog is full");
        }
        dispatcher.dispatch(input, envelope, request.log).catch((error) => {
          // dispatch already delivered or logged the failure; this only prevents a
          // rejected background job becoming an unhandled rejection.
          request.log.error({ err: error, stage: "chat.async_failed" });
        });
        reply.code(202);
        return { accepted: true, request_id: envelope.request_id };
      },
    );

    app.post(
      "/chat",
      { schema: { body: ChatRequestSchema } },
      async (request) => {
        const start = performance.now();
        try {
          const input = request.body;
          if (config.LOG_CHAT_REQUEST_BODY) {
            request.log.info({ stage: "chat.request", body: input });
          }
          const response = await rag.chat(input, request.log);
          request.log.info({
            stage: "chat.total",
            ms: Math.round(performance.now() - start),
            route: response.route,
            tools_used: response.tools_used,
            sources: response.sources.length,
          });
          return response;
        } catch (error) {
          request.log.error({
            stage: "chat.total",
            ms: Math.round(performance.now() - start),
            error,
          });
          throw error;
        }
      },
    );

    app.post("/query", { schema: { body: QueryRequestSchema } }, (request) =>
      rag.query(request.body),
    );
  };
}
