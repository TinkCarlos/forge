import fs from "node:fs";
import path from "node:path";
import { type FastifyInstance } from "fastify";

export default async function consoleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_request, reply) => {
    const file = path.resolve(process.cwd(), "apps/console/public/index.html");
    return reply.type("text/html").send(fs.readFileSync(file, "utf8"));
  });
}
