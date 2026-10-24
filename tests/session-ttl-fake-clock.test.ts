import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getSession, sessionCookieValue, type Session } from "@forge/identity";
import { config } from "@forge/core";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// I-G-03: sessions expire after their TTL (8h, StoredSession.expiresAt). Only Date is faked (toFake: ["Date"]) so
// mysql2 / Fastify timers keep running; the clock is moved relative to each session's own expiresAt.
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
let app: FastifyInstance;
const users = (session: Session) => app.inject({ method: "GET", url: "/admin/api/users", headers: sessionHeaders(session, sessionCookieValue(session)) });
const admin = () => realSession({ role: "platform_admin", orgUnitId: null, dataScope: "all" });

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  vi.useRealTimers();
  await cleanupRealSessions();
  await app?.close();
});

describe("I-G-03: session TTL (fake clock)", () => {
  it("TTL is 8h from creation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T08:00:00Z"));
    const session = await admin();
    expect(session.expiresAt - Date.now()).toBe(SESSION_TTL_MS);
  });

  it("N-01: createSession uses config.SESSION_TTL_SECONDS", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T08:00:00Z"));
    const session = await admin();
    expect(typeof config.SESSION_TTL_SECONDS).toBe("number");
    expect(session.expiresAt - Date.now()).toBe(config.SESSION_TTL_SECONDS * 1000);
  });

  it("boundary: at TTL minus 1 second the session is still valid (getSession + cookie -> 200)", async () => {
    const session = await admin();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(session.expiresAt - 1000);
    expect(getSession(session.token)?.userId).toBe(session.userId);
    const res = await users(session);
    expect(res.statusCode).toBe(200);
  });

  it("past the TTL: getSession returns null", async () => {
    const session = await admin();
    expect(getSession(session.token)).not.toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(session.expiresAt + 1000);
    expect(getSession(session.token)).toBeNull();
  });

  it("past the TTL: the old (correctly signed) cookie -> 401, and it stays rejected after the clock is reset", async () => {
    const session = await admin();
    expect((await users(session)).statusCode).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(session.expiresAt + 1000);
    const res = await users(session);
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toMatch(/^AUTH-/);
    vi.useRealTimers();
    // The expired session was dropped, not merely hidden by the clock.
    expect((await users(session)).statusCode).toBe(401);
    expect(getSession(session.token)).toBeNull();
  });
});
