import type { FastifyPluginAsync } from "fastify";
import type { VectorStore } from "../services/qdrant.js";

/**
 * Liveness and readiness are distinct signals and need distinct status codes. A
 * single 200-for-both endpoint gives an orchestrator nothing to act on: `qdrant:
 * false` inside a 200 body means a replica that cannot reach Qdrant keeps taking
 * traffic and answers every question with "no match".
 *
 * - `/health`: 200 while the process is up, Qdrant state in the body. Shape held
 *   fixed — the container healthcheck and Frappe both call it.
 * - `/health/live`: process check, 200 unconditionally.
 * - `/health/ready`: traffic check, 503 while Qdrant is unreachable.
 */
export function healthRoutes(store: VectorStore): FastifyPluginAsync {
  return async (app) => {
    app.get("/health", async () => ({
      ok: true,
      qdrant: await store.health(),
    }));

    app.get("/health/live", () => ({ ok: true }));

    app.get("/health/ready", async (_request, reply) => {
      const qdrant = await store.health();
      if (!qdrant) reply.code(503);
      return { ok: qdrant, qdrant };
    });
  };
}
