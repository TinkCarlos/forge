import { type FastifyInstance } from "fastify";
import { errors } from "@forge/core";
import { readSession } from "./http-helpers.js";

// Root-level preHandler: enforces X-CSRF-Token on mutating /admin/api requests that carry a session.
export function installCsrfHook(app: FastifyInstance): void {
  app.addHook("preHandler", async (request) => {
    if (request.url.startsWith("/admin/api") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const session = readSession(request);
      if (session && request.headers["x-csrf-token"] !== session.csrfToken) {
        throw errors.forbidden("CSRF Token 缺失或无效");
      }
    }
  });
}
