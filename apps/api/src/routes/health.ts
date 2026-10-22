import { type FastifyInstance } from "fastify";
import { healthCheck } from "@forge/store";

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => ({ status: "ok", service: "forge", version: "0.1.0" }));
  app.get("/readyz", async (_request, reply) => {
    const db = await healthCheck();
    reply.status(db ? 200 : 503).send({ status: db ? "ready" : "not_ready", database: db });
  });
}
