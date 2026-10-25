import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import { AUTH_GC_BATCH, AUTH_GC_INTERVAL_MS, AUTH_GC_LOCK, collectExpiredAuth } from "@forge/runtime";
import { pool, query } from "@forge/store";
import { cleanupRealSessions, realSession } from "./helpers/real-session.js";

// SS-09 (session store): the worker deletes expired auth_sessions / auth_oidc_states every 10 minutes, in batches of
// LIMIT 1000, under GET_LOCK('forge:auth-gc', 0) so only one worker runs it at a time. Live rows are never touched.
const hex = () => randomBytes(32).toString("hex");
let userId = "";
const past = () => new Date(Date.now() - 60_000);
const future = () => new Date(Date.now() + 60 * 60_000);
const count = async (sql: string, params: unknown[] = []) => Number((await query<{ n: number }>(sql, params))[0]!.n);
const expiredSessions = () => count("SELECT COUNT(*) AS n FROM auth_sessions WHERE expires_at <= ?", [new Date()]);
const expiredStates = () => count("SELECT COUNT(*) AS n FROM auth_oidc_states WHERE expires_at <= ?", [new Date()]);
const liveTagged = (hashes: string[]) => count("SELECT COUNT(*) AS n FROM auth_sessions WHERE token_hash IN (?)", [hashes]);

async function seedExpired(sessions: number, states: number): Promise<void> {
  const sessionRows = Array.from({ length: sessions }, () => [hex(), userId, "csrf", past(), past(), past()]);
  for (let i = 0; i < sessionRows.length; i += 500) {
    await pool.query("INSERT INTO auth_sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES ?", [sessionRows.slice(i, i + 500)]);
  }
  const stateRows = Array.from({ length: states }, () => [hex(), "v", "n", "/next/", past(), past()]);
  for (let i = 0; i < stateRows.length; i += 500) {
    await pool.query("INSERT INTO auth_oidc_states (state_hash, verifier, nonce, return_to, created_at, expires_at) VALUES ?", [stateRows.slice(i, i + 500)]);
  }
}

beforeAll(async () => {
  userId = (await realSession({ role: "user", orgUnitId: null, dataScope: "self" })).userId;
});
afterAll(async () => {
  vi.restoreAllMocks();
  await cleanupRealSessions();
});

describe("SS-09: expired auth rows cleanup (worker)", () => {
  it("SS-09: constants: every 10 minutes, LIMIT 1000, lock name forge:auth-gc", () => {
    expect(AUTH_GC_INTERVAL_MS).toBe(10 * 60 * 1000);
    expect(AUTH_GC_BATCH).toBe(1000);
    expect(AUTH_GC_LOCK).toBe("forge:auth-gc");
  });

  it("SS-09: more than one batch of expired rows is fully deleted in LIMIT 1000 batches; live rows stay", async () => {
    await seedExpired(2500, 1200);
    const live = [hex(), hex()];
    for (const hash of live) await pool.query("INSERT INTO auth_sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, 'c', ?)", [hash, userId, future()]);
    const statements: string[] = [];
    const getConnection = pool.getConnection.bind(pool);
    const spy = vi.spyOn(pool, "getConnection").mockImplementation(async () => {
      const conn = await getConnection();
      const original = conn.query.bind(conn) as (...args: unknown[]) => Promise<unknown>;
      return new Proxy(conn, {
        get(target, key, receiver) {
          if (key === "query") return (sql: unknown, ...rest: unknown[]) => (statements.push(String(sql)), original(sql, ...rest));
          return Reflect.get(target, key, receiver) as unknown;
        },
      }) as PoolConnection;
    });
    let result: Awaited<ReturnType<typeof collectExpiredAuth>>;
    try {
      result = await collectExpiredAuth();
    } finally {
      spy.mockRestore();
    }
    expect(result.ran).toBe(true);
    expect(result.sessions).toBeGreaterThanOrEqual(2500);
    expect(result.states).toBeGreaterThanOrEqual(1200);
    expect(await expiredSessions()).toBe(0);
    expect(await expiredStates()).toBe(0);
    expect(await liveTagged(live)).toBe(2);
    const sessionDeletes = statements.filter((sql) => sql.startsWith("DELETE FROM auth_sessions"));
    expect(sessionDeletes.length).toBeGreaterThanOrEqual(3);
    for (const sql of sessionDeletes) expect(sql).toMatch(/expires_at <= \? .*LIMIT \?$/);
    expect(statements[0]).toMatch(/GET_LOCK/);
    expect(statements.at(-1)).toMatch(/RELEASE_LOCK/);
    await pool.query("DELETE FROM auth_sessions WHERE token_hash IN (?)", [live]);
  });

  it("SS-09: while another connection holds GET_LOCK('forge:auth-gc'), the job skips (nothing deleted); after release it runs", async () => {
    await seedExpired(30, 10);
    const holder = await pool.getConnection();
    try {
      const [rows] = await holder.query("SELECT GET_LOCK(?, 0) AS got", [AUTH_GC_LOCK]);
      expect((rows as Array<{ got: number }>)[0]!.got).toBe(1);
      const skipped = await collectExpiredAuth();
      expect(skipped).toEqual({ ran: false, sessions: 0, states: 0 });
      expect(await expiredSessions()).toBeGreaterThanOrEqual(30);
    } finally {
      await holder.query("SELECT RELEASE_LOCK(?)", [AUTH_GC_LOCK]);
      holder.release();
    }
    expect((await collectExpiredAuth()).ran).toBe(true);
    expect(await expiredSessions()).toBe(0);
  });

  it("SS-09: two concurrent runs: no error, every expired row deleted exactly once in total", async () => {
    await seedExpired(1500, 1100);
    const results = await Promise.all([collectExpiredAuth(), collectExpiredAuth()]);
    expect(results.reduce((sum, r) => sum + r.sessions, 0)).toBeGreaterThanOrEqual(1500);
    expect(results.reduce((sum, r) => sum + r.states, 0)).toBeGreaterThanOrEqual(1100);
    expect(await expiredSessions()).toBe(0);
    expect(await expiredStates()).toBe(0);
  });

});
