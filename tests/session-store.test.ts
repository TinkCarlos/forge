import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createSession, getSession, sessionCookieValue, sha256Hex, SESSION_LAST_SEEN_THROTTLE_MS, type Session } from "@forge/identity";
import { one, pool, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";
import { secondInstance, type SecondInstance } from "./helpers/second-instance.js";

// Session store (migration 007): sessions live in auth_sessions, so every forge-api replica sees the same sessions.
// Instance A is this module graph; instance B is a fresh module graph with its own pool (helpers/second-instance.ts).
let appA: FastifyInstance;
let b: SecondInstance;
const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string } }).error;
const sessionOn = (app: FastifyInstance, session: Session) => app.inject({ method: "GET", url: "/auth/session", headers: sessionHeaders(session, sessionCookieValue(session)) });
const usersOn = (app: FastifyInstance, session: Session) => app.inject({ method: "GET", url: "/admin/api/users", headers: sessionHeaders(session, sessionCookieValue(session)) });
const admin = () => realSession({ role: "platform_admin", orgUnitId: null, dataScope: "all" });
const rowOf = (session: Session) => one<{ token_hash: string; user_id: string; csrf_token: string; last_seen_at: Date; expires_at: Date }>("SELECT * FROM auth_sessions WHERE token_hash = ?", [sha256Hex(session.token)]);

beforeAll(async () => {
  appA = await buildApp({ logger: false });
  await appA.ready();
  b = await secondInstance();
});
afterAll(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cleanupRealSessions();
  await appA?.close();
  await b?.close();
});

describe("session store: shared across instances", () => {
  it("SS-01: login on A, /auth/session on B -> 200; the CSRF token from A is accepted by B (wrong token -> 403)", async () => {
    expect(b.pool).not.toBe(pool);
    const session = await admin();
    const resB = await sessionOn(b.app, session);
    expect(resB.statusCode).toBe(200);
    expect((resB.json() as { csrfToken: string }).csrfToken).toBe(session.csrfToken);
    const cookie = `forge_session=${sessionCookieValue(session)}`;
    const patch = (csrf: string) => b.app.inject({ method: "PATCH", url: "/admin/api/users/01J0000000000000000000NONE", headers: { cookie, "x-csrf-token": csrf }, payload: { status: "active" } });
    expect((await patch("wrong-token")).statusCode).toBe(403);
    const ok = await patch(session.csrfToken);
    expect(ok.statusCode).not.toBe(403);
    expect(ok.statusCode).not.toBe(401);
  });

  it("SS-03: only the SHA-256 of the token is stored; the raw token appears in no column", async () => {
    const session = await admin();
    const row = await rowOf(session);
    expect(row?.token_hash).toBe(sha256Hex(session.token));
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.user_id).toBe(session.userId);
    const raw = await query("SELECT token_hash FROM auth_sessions WHERE token_hash = ? OR csrf_token = ? OR user_id = ?", [session.token, session.token, session.token]);
    expect(raw).toHaveLength(0);
    expect(JSON.stringify(row)).not.toContain(session.token);
  });

  it("SS-04: past the absolute expiry -> 401 on both instances (fake Date only)", async () => {
    const session = await admin();
    expect((await usersOn(appA, session)).statusCode).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(session.expiresAt + 1000);
    try {
      const resA = await usersOn(appA, session);
      expect(resA.statusCode).toBe(401);
      expect(errorOf(resA).code).toMatch(/^AUTH-/);
      expect((await usersOn(b.app, session)).statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SS-05: logout on A -> the same cookie is 401 on B, and the row is gone", async () => {
    const session = await admin();
    expect((await sessionOn(b.app, session)).statusCode).toBe(200);
    const out = await appA.inject({ method: "POST", url: "/auth/logout", headers: sessionHeaders(session, sessionCookieValue(session)) });
    expect(out.statusCode).toBe(200);
    expect(await rowOf(session)).toBeNull();
    expect((await sessionOn(b.app, session)).statusCode).toBe(401);
    expect((await sessionOn(appA, session)).statusCode).toBe(401);
  });

  it("SS-10: last_seen_at is refreshed at most once per throttle window; expires_at never moves (no sliding renewal)", async () => {
    const session = await admin();
    const before = await rowOf(session);
    const stale = new Date(Date.now() - SESSION_LAST_SEEN_THROTTLE_MS - 60_000);
    await pool.execute("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?", [stale, sha256Hex(session.token)]);
    expect((await sessionOn(b.app, session)).statusCode).toBe(200);
    const touched = await rowOf(session);
    expect(new Date(touched!.last_seen_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(new Date(touched!.expires_at).getTime()).toBe(new Date(before!.expires_at).getTime());
    const fresh = new Date(Date.now() - 60_000);
    await pool.execute("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?", [fresh, sha256Hex(session.token)]);
    expect((await sessionOn(appA, session)).statusCode).toBe(200);
    expect(new Date((await rowOf(session))!.last_seen_at).getTime()).toBe(fresh.getTime());
    expect(new Date((await rowOf(session))!.expires_at).getTime()).toBe(new Date(before!.expires_at).getTime());
  });

  it("SS-11: a session-store DB failure -> 503 SYS-9003 (not 401), session kept and valid after recovery", async () => {
    const session = await admin();
    const spy = vi.spyOn(repos, "getAuthSession").mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 10.9.9.9:3306"), { code: "ECONNREFUSED" }));
    let resSession: LightMyRequestResponse;
    let resUsers: LightMyRequestResponse;
    try {
      resSession = await sessionOn(appA, session);
      resUsers = await usersOn(appA, session);
    } finally {
      spy.mockRestore();
    }
    for (const res of [resSession, resUsers]) {
      expect(res.statusCode).toBe(503);
      expect(errorOf(res).code).toBe("SYS-9003");
      expect(res.body).not.toContain("10.9.9.9");
    }
    expect(await rowOf(session)).not.toBeNull();
    expect((await sessionOn(appA, session)).statusCode).toBe(200);
  });

  it("SS-12: a cookie with a tampered signature -> 401 without any database query", async () => {
    const session = await admin();
    const value = sessionCookieValue(session);
    const tampered = `${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`;
    const spies = [vi.spyOn(pool, "query"), vi.spyOn(pool, "execute"), vi.spyOn(pool, "getConnection")];
    let res: LightMyRequestResponse;
    try {
      res = await appA.inject({ method: "GET", url: "/auth/session", headers: { cookie: `forge_session=${tampered}` } });
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(res.statusCode).toBe(401);
    expect(await getSession(session.token)).not.toBeNull();
  });

  it("SS-14: a session whose expires_at is in the past is rejected with no cleanup run (row still present before the request)", async () => {
    const session = await admin();
    expect((await sessionOn(b.app, session)).statusCode).toBe(200);
    await pool.execute("UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?", [new Date(Date.now() - 1000), sha256Hex(session.token)]);
    expect(await rowOf(session)).not.toBeNull();
    expect((await sessionOn(b.app, session)).statusCode).toBe(401);
    expect((await usersOn(appA, session)).statusCode).toBe(401);
    expect(await getSession(session.token)).toBeNull();
  });

  it("SS-16: rejecting an expired session runs no DELETE; the row stays for the cleanup job (401, row present after the request)", async () => {
    const session = await admin();
    await pool.execute("UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?", [new Date(Date.now() - 1000), sha256Hex(session.token)]);
    const spies = [vi.spyOn(pool, "query"), vi.spyOn(pool, "execute")];
    let res: LightMyRequestResponse;
    let lookedUp: unknown;
    try {
      res = await sessionOn(appA, session);
      lookedUp = await getSession(session.token);
    } finally {
      const sql = spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0]).trim()));
      for (const spy of spies) spy.mockRestore();
      expect(sql.some((text) => /auth_sessions/i.test(text))).toBe(true);
      expect(sql.filter((text) => /^DELETE\b/i.test(text))).toEqual([]);
    }
    expect(res.statusCode).toBe(401);
    expect(lookedUp).toBeNull();
    expect(await rowOf(session)).not.toBeNull();
    await repos.deleteAuthSession(sha256Hex(session.token));
  });

  it("createSession is stored with the configured absolute TTL", async () => {
    const session = await createSession({ type: "user", id: (await admin()).userId, name: "x", role: "platform_admin", orgUnitId: null, dataScope: "all" });
    const row = await rowOf(session);
    expect(new Date(row!.expires_at).getTime()).toBe(session.expiresAt);
    await repos.deleteAuthSession(sha256Hex(session.token));
  });
});
