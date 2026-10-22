import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { config, errors, ForgeError } from "@forge/core";
import { startRuntime } from "@forge/runtime";
import {
  reqId,
  readSession,
} from "./plugins/http-helpers.js";
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import integrationRoutes from "./routes/integration.js";
import openRoutes from "./routes/open.js";
import adminRoutes from "./routes/admin/index.js";

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport: config.NODE_ENV === "development" ? { target: "pino-pretty", options: { translateTime: "SYS:standard" } } : undefined,
  },
  bodyLimit: 2 * 1024 * 1024,
  requestIdHeader: "x-request-id",
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
await app.register(fastifyStatic, {
  root: path.resolve(process.cwd(), "apps/console/public"),
  prefix: "/assets/",
});

// ---------- errors / CSRF ----------

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ForgeError) {
    reply.status(error.httpStatus).send({
      error: {
        code: error.code,
        message: error.message,
        requestId: reqId(request),
        details: error.details ?? null,
        retryable: error.retryable,
      },
    });
    return;
  }
  request.log.error(error);
  reply.status(500).send({
    error: { code: "SYS-9001", message: "内部错误", requestId: reqId(request), retryable: false },
  });
});

app.addHook("preHandler", async (request) => {
  if (request.url.startsWith("/admin/api") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const session = readSession(request);
    if (session && request.headers["x-csrf-token"] !== session.csrfToken) {
      throw errors.forbidden("CSRF Token 缺失或无效");
    }
  }
});

// ---------- health / auth ----------

await app.register(healthRoutes);

await app.register(authRoutes);

await app.register(adminRoutes);

await app.register(openRoutes);

await app.register(integrationRoutes);

// ---------- static console ----------

app.get("/", async (_request, reply) => {
  const file = path.resolve(process.cwd(), "apps/console/public/index.html");
  return reply.type("text/html").send(fs.readFileSync(file, "utf8"));
});

const port = config.PORT;
await app.listen({ port, host: config.HOST });
if (config.EMBEDDED_WORKER) startRuntime();
console.log(`Forge API listening on ${config.FORGE_PUBLIC_URL} (local http://localhost:${port})`);

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
