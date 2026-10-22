import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { config } from "@forge/core";
import type { ConnectorConfig } from "@forge/identity";
import { installErrorHandler } from "./plugins/errors.js";
import { installCsrfHook } from "./plugins/csrf.js";
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
}

/** Builds the Fastify app without listening or starting the runtime, so tests can use app.inject(). */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger ?? {
        level: config.LOG_LEVEL,
        transport: config.NODE_ENV === "development" ? { target: "pino-pretty", options: { translateTime: "SYS:standard" } } : undefined,
      },
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: "x-request-id",
  });

  app.decorate("forgeConfig", options.config ? { ...config, ...options.config } : config);

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), "apps/console/public"),
    prefix: "/assets/",
  });

  installErrorHandler(app);
  installCsrfHook(app);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(openRoutes);
  await app.register(integrationRoutes);
  await app.register(consoleRoutes);

  return app;
}
