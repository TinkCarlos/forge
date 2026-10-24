import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { config } from "@forge/core";
import type { ConnectorConfig } from "@forge/identity";
import { auditUserAgent, runWithAuditContext } from "@forge/store";
import { frameworkErrorHandler, installErrorHandler } from "./plugins/errors.js";
import { installCsrfHook } from "./plugins/csrf.js";
import { installAdminMultipartGuard } from "./plugins/multipart-guard.js";
import { installSecurityHeaders } from "./plugins/security-headers.js";
import { installSanitizedNotFoundHandler, requestLogSerializers } from "./plugins/log-sanitize.js";
import { AJV_CUSTOM_OPTIONS } from "./plugins/input-schema.js";
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin/index.js";
import openRoutes from "./routes/open.js";
import integrationRoutes from "./routes/integration.js";
import consoleRoutes from "./routes/console.js";

/** Config overridable per app instance. Only fields routes read via `app.forgeConfig` belong here (today: connector verification). */
export type AppConfigOverrides = Partial<ConnectorConfig>;

declare module "fastify" {
  interface FastifyInstance {
    /** Global @forge/core config with buildApp({ config }) overrides merged on top. */
    forgeConfig: ConnectorConfig;
  }
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  /** Test hook: overrides merged over @forge/core config. Omit for default (env-driven) behavior. */
  config?: AppConfigOverrides;
  /**
   * P3-10: Fastify trustProxy. Default false: request.ip is the socket address and X-Forwarded-For is ignored (a
   * client could forge it). Set only when the API runs behind a known reverse proxy.
   */
  trustProxy?: FastifyServerOptions["trustProxy"];
}

/**
 * K-26: request URLs are always logged with sensitive query values redacted, also for caller-provided logger options
 * (tests, embedding). `false`/`true` pass through unchanged; an explicit caller `serializers.req` still wins.
 */
function withRequestLogSerializers(logger: FastifyServerOptions["logger"]): FastifyServerOptions["logger"] {
  if (!logger || typeof logger !== "object") return logger;
  return { ...logger, serializers: { ...requestLogSerializers, ...logger.serializers } };
}

/** Builds the Fastify app without listening or starting the runtime, so tests can use app.inject(). */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: withRequestLogSerializers(
      options.logger ?? {
        level: config.LOG_LEVEL,
        transport: config.NODE_ENV === "development" ? { target: "pino-pretty", options: { translateTime: "SYS:standard" } } : undefined,
      },
    ),
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: options.trustProxy ?? false,
    requestIdHeader: "x-request-id",
    // Route input schemas (plugins/input-schema.ts): no type coercion, so 42 is not accepted as a string.
    ajv: { customOptions: AJV_CUSTOM_OPTIONS },
    // P2-01: a malformed URL gets the unified 400 body without echoing the path (Fastify's default repeats it).
    frameworkErrors: frameworkErrorHandler,
  });

  // I-DOC-16: JSON is the only body type the routes read. Fastify's built-in text/plain parser handed the raw string to
  // the route (then "缺少字段" / 401); without it a text/plain body is 415 OPN-4505 like XML, forms or no Content-Type.
  app.removeContentTypeParser("text/plain");

  app.decorate("forgeConfig", options.config ? { ...config, ...options.config } : config);

  // P3-10: audit rows written while serving this request carry ip / userAgent (<= 512) / requestId in details_json.
  app.addHook("preHandler", (request, _reply, done) => {
    runWithAuditContext({ ip: request.ip ?? null, userAgent: auditUserAgent(request.headers["user-agent"]), requestId: String(request.id) }, done);
  });

  installSecurityHeaders(app);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), "apps/console/public"),
    prefix: "/assets/",
  });

  installErrorHandler(app);
  installAdminMultipartGuard(app); // item 8: before CSRF / auth
  installCsrfHook(app);
  installSanitizedNotFoundHandler(app);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(openRoutes);
  await app.register(integrationRoutes);
  await app.register(consoleRoutes);

  return app;
}
