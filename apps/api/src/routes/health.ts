import { type FastifyInstance } from "fastify";
import { healthCheck } from "@forge/store";
import { isDraining } from "../plugins/sse-shutdown.js";

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => ({ status: "ok", service: "forge", version: "0.1.0" }));
  app.get("/readyz", async (_request, reply) => {
    const db = await healthCheck();
    // r4 shutdown: not ready from the start of app.close() (preClose); same 503 / not_ready body as a DB outage.
    const ready = db && !isDraining(app);
    reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", database: db });
  });
}
