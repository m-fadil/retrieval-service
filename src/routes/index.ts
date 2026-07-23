import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.js";
import {
  AnswerRequestSchema,
  ChatAsyncEnvelopeSchema,
  ChatRequestSchema,
  IndexRequestSchema,
  QueryRequestSchema,
  SearchRequestSchema,
} from "../schemas/query.js";
import type { ChatDispatcher } from "../services/dispatch.js";
import type { RagService } from "../services/rag.js";

export function apiRoutes(
  config: Pick<AppConfig, "LOG_CHAT_REQUEST_BODY">,
  rag: RagService,
  dispatcher: ChatDispatcher,
): FastifyPluginAsync {
  return async (app) => {
    app.post("/index", async (request) =>
      rag.index(IndexRequestSchema.parse(request.body)),
    );
    app.post("/search", async (request) =>
      rag.search(SearchRequestSchema.parse(request.body)),
    );
    app.post("/answer", async (request) =>
      rag.answer(AnswerRequestSchema.parse(request.body), request.log),
    );
    // Accepts the job and returns immediately; the answer is delivered to
    // Frappe by the dispatcher, so no caller-side worker waits out the LLM.
    app.post("/chat/async", async (request, reply) => {
      const envelope = ChatAsyncEnvelopeSchema.parse(request.body);
      const input = ChatRequestSchema.parse(request.body);
      if (config.LOG_CHAT_REQUEST_BODY) {
        request.log.info({ stage: "chat.request", body: input });
      }
      void dispatcher.dispatch(input, envelope, request.log);
      reply.code(202);
      return { accepted: true, request_id: envelope.request_id };
    });
    app.post("/chat", async (request) => {
      const start = performance.now();
      try {
        const input = ChatRequestSchema.parse(request.body);
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
    });
    app.post("/query", async (request) =>
      rag.query(QueryRequestSchema.parse(request.body)),
    );
  };
}
