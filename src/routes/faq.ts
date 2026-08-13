import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "../plugins/zod.js";
import {
  FaqBulkRequestSchema,
  FaqGenerateRequestSchema,
  FaqReindexRequestSchema,
  FaqSchema,
} from "../schemas/faq.js";
import type { FaqService } from "../services/faq.js";
import type { RagService } from "../services/rag.js";

const FaqIdParams = z.object({ id: z.string().min(1) });

// Authentication is enforced globally in buildApp; see routes/auth.ts.
export function faqRoutes(
  faq: FaqService,
  rag: RagService,
): FastifyPluginAsync {
  return async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();

    app.post(
      "/faq/bulk",
      { schema: { body: FaqBulkRequestSchema } },
      (request) => faq.bulk(request.body),
    );

    app.post(
      "/faq/reindex",
      { schema: { body: FaqReindexRequestSchema } },
      (request) => faq.reindex(request.body, request.log),
    );

    // Drops the whole Qdrant collection (every source), then reindexes from the
    // given items. Scoped to embedding model/dimension changes; non-FAQ documents
    // must be re-sent via POST /index afterwards.
    app.post(
      "/faq/recreate",
      { schema: { body: FaqReindexRequestSchema } },
      (request) => faq.recreate(request.body, request.log),
    );

    app.get("/faq/reindex/status", () => faq.reindexStatus());

    // Distils a support transcript into a draft FAQ. Returns the draft only;
    // storing it is the caller's decision, with /search for dedup.
    app.post(
      "/faq/generate",
      { schema: { body: FaqGenerateRequestSchema } },
      (request) => rag.generateFaq(request.body, request.log),
    );

    app.put(
      "/faq/:id",
      { schema: { params: FaqIdParams, body: FaqSchema } },
      (request) => faq.upsert(request.params.id, request.body),
    );

    app.delete("/faq/:id", { schema: { params: FaqIdParams } }, (request) =>
      faq.delete(request.params.id),
    );
  };
}
