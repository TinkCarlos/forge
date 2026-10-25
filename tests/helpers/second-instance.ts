import { vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * A second forge-api "replica" inside the test process: vi.resetModules() gives it its own module graph, so it has its
 * own @forge/identity / @forge/store module state and its own mysql2 pool, exactly like a separate process sharing the
 * same database. Anything kept in process memory is NOT visible to it. close() also ends its pool.
 */
export interface SecondInstance {
  app: FastifyInstance;
  pool: { end: () => Promise<void> };
  identity: typeof import("@forge/identity");
  core: typeof import("@forge/core");
  close: () => Promise<void>;
}

export async function secondInstance(): Promise<SecondInstance> {
  vi.resetModules();
  const { buildApp } = await import("../../apps/api/src/app.js");
  const store = await import("@forge/store");
  const identity = await import("@forge/identity");
  const core = await import("@forge/core");
  const app = await buildApp({ logger: false });
  await app.ready();
  return {
    app,
    pool: store.pool,
    identity,
    core,
    close: async () => {
      await app.close();
      await store.pool.end();
    },
  };
}
