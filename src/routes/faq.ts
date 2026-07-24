import type { FastifyPluginAsync } from "fastify";
import {
  FaqBulkRequestSchema,
  FaqGenerateRequestSchema,
  FaqReindexRequestSchema,
  FaqSchema,
} from "../schemas/faq.js";
import type { FaqService } from "../services/faq.js";
import type { RagService } from "../services/rag.js";

// Authentication is enforced globally in buildApp; see routes/auth.ts.
export function faqRoutes(
  faq: FaqService,
  rag: RagService,
): FastifyPluginAsync {
  return async (app) => {
    app.post("/faq/bulk", async (request) =>
      faq.bulk(FaqBulkRequestSchema.parse(request.body)),
    );
    app.post("/faq/reindex", async (request) =>
      faq.reindex(FaqReindexRequestSchema.parse(request.body), request.log),
    );
    // Drops the whole Qdrant collection (every source), then reindexes from
    // the given items. For embedding model/dimension changes; non-FAQ
    // documents must be re-sent via POST /index afterwards.
    app.post("/faq/recreate", async (request) =>
      faq.recreate(FaqReindexRequestSchema.parse(request.body), request.log),
    );
    app.get("/faq/reindex/status", async () => faq.reindexStatus());

    // Distils a support transcript into a draft FAQ. Returns the draft only;
    // deciding whether to store it is the caller's, via /search for dedup.
    app.post("/faq/generate", async (request) =>
      rag.generateFaq(
        FaqGenerateRequestSchema.parse(request.body),
        request.log,
      ),
    );

    app.put<{ Params: { id: string } }>("/faq/:id", async (request) =>
      faq.upsert(request.params.id, FaqSchema.parse(request.body)),
    );

    app.delete<{ Params: { id: string } }>("/faq/:id", async (request) =>
      faq.delete(request.params.id),
    );
  };
}
