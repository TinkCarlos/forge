import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import mysql from "mysql2/promise";
import { sessionCookieValue, type Session } from "@forge/identity";
import { pool } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// SS-15 (session store): every authenticated request now reads auth_sessions. Under a burst of ~3x the pool size, the
// process must stay within its mysql2 pool (connectionLimit 20, packages/store/src/db.ts): extra requests queue
// (waitForConnections, queueLimit 0) and all succeed. Main assertion: peak checked-out pool connections (acquire /
// release events, plus the pool's own all/free lists) <= limit. Auxiliary: information_schema.PROCESSLIST rows for this
// test database, sampled on a separate (non-pool) connection whose own row is subtracted. max_connections untouched.
interface PoolInternals {
  config: { connectionLimit: number };
  _allConnections: { length: number };
  _freeConnections: { length: number };
}
const internals = () => (pool as unknown as { pool: PoolInternals }).pool;
let app: FastifyInstance;
let session: Session;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  session = await realSession({ role: "platform_admin", orgUnitId: null, dataScope: "all" });
});
afterAll(async () => {
  await cleanupRealSessions();
  await app?.close();
});

describe("SS-15: concurrent authenticated requests stay within the connection pool", () => {
  it("SS-15: 3x pool-size concurrent session requests -> all 200, peak pool connections <= connectionLimit, PROCESSLIST peak <= limit", { timeout: 60_000 }, async () => {
    const limit = internals().config.connectionLimit;
    expect(limit).toBe(20);
    const concurrency = limit * 3;

    let active = 0;
    let peakActive = 0;
    let peakAll = 0;
    let peakCheckedOut = 0;
    let enqueued = 0;
    const sample = () => {
      peakAll = Math.max(peakAll, internals()._allConnections.length);
      peakCheckedOut = Math.max(peakCheckedOut, internals()._allConnections.length - internals()._freeConnections.length);
    };
    const onAcquire = () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      sample();
    };
    const onRelease = () => {
      active -= 1;
      sample();
    };
    const onEnqueue = () => {
      enqueued += 1;
      sample();
    };
    pool.on("acquire", onAcquire);
    pool.on("release", onRelease);
    pool.on("enqueue", onEnqueue);

    // Separate sampler connection (not from the pool); it is itself one PROCESSLIST row for this database.
    const sampler = await mysql.createConnection({ uri: process.env.DATABASE_URL ?? "" });
    let peakProcesslist = 0;
    let sampling = true;
    const sampleLoop = (async () => {
      while (sampling) {
        const [rows] = await sampler.query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB = DATABASE()");
        peakProcesslist = Math.max(peakProcesslist, Number((rows as Array<{ n: number }>)[0]!.n) - 1);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();

    let results: LightMyRequestResponse[];
    try {
      const headers = sessionHeaders(session, sessionCookieValue(session));
      results = await Promise.all(
        Array.from({ length: concurrency }, (_, i) =>
          i % 2 ? app.inject({ method: "GET", url: "/admin/api/users", headers }) : app.inject({ method: "GET", url: "/auth/session", headers }),
        ),
      );
    } finally {
      sampling = false;
      await sampleLoop;
      await sampler.end();
      pool.off("acquire", onAcquire);
      pool.off("release", onRelease);
      pool.off("enqueue", onEnqueue);
    }

    const statuses = results.map((res) => res.statusCode);
    expect(statuses.filter((status) => status !== 200), JSON.stringify(results.find((res) => res.statusCode !== 200)?.body ?? "")).toEqual([]);
    expect(results.some((res) => /Too many connections|SYS-9003/.test(res.body))).toBe(false);
    expect(peakActive).toBeGreaterThan(0);
    expect(enqueued).toBeGreaterThan(0); // the burst really exceeded the pool and queued
    expect(peakActive).toBeLessThanOrEqual(limit);
    expect(peakCheckedOut).toBeLessThanOrEqual(limit);
    expect(peakAll).toBeLessThanOrEqual(limit);
    expect(peakProcesslist).toBeLessThanOrEqual(limit);
    console.info(`SS-15 metrics: concurrency=${concurrency} limit=${limit} peakActive=${peakActive} peakCheckedOut=${peakCheckedOut} peakAll=${peakAll} enqueued=${enqueued} peakProcesslist=${peakProcesslist}`);
  });
});
