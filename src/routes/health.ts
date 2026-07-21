import type { FastifyPluginAsync } from "fastify";
import type { VectorStore } from "../services/qdrant.js";

export function healthRoutes(store: VectorStore): FastifyPluginAsync {
  return async (app) => {
    app.get("/health", async () => ({
      ok: true,
      qdrant: await store.health(),
    }));
  };
}
