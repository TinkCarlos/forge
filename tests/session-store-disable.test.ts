import { configurationHeaders } from "./helpers/configuration-headers.js";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PoolConnection } from "mysql2/promise";
import { sessionCookieValue, type Session } from "@forge/identity";
import { execute, pool, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";
import { secondInstance, type SecondInstance } from "./helpers/second-instance.js";

// SS-06 (session store): disabling a user deletes all of that user's sessions in the same transaction as the status
// change (behaviour change: immediate logout everywhere). A disabled department still logs its users out (401) via the
// live principal check; its sessions are not deleted.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ORG = `01JSS06${randomBytes(10).toString("hex").toUpperCase().slice(0, 19)}`;
let appA: FastifyInstance;
let b: SecondInstance;
let platform: Record<string, string>;
const sessionOn = (app: FastifyInstance, session: Session) => app.inject({ method: "GET", url: "/auth/session", headers: sessionHeaders(session, sessionCookieValue(session)) });
const rowsOf = async (userId: string) => (await query<{ n: number }>("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?", [userId]))[0]!.n;
const disable = async (userId: string) => appA.inject({ method: "PATCH", url: `/admin/api/users/${userId}`, headers: await configurationHeaders(`/admin/api/users/${userId}`, platform), payload: { status: "disabled" } });

beforeAll(async () => {
  appA = await buildApp({ logger: false });
  await appA.ready();
  b = await secondInstance();
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [ORG, ROOT, `it-ss06-${suffix}`, "IT ss06", `/it-ss06-${suffix}/`]);
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  platform = sessionHeaders(pa, sessionCookieValue(pa));
});
afterAll(async () => {
  vi.restoreAllMocks();
  await cleanupRealSessions();
  await execute("DELETE FROM org_units WHERE id = ?", [ORG]);
  await appA?.close();
  await b?.close();
});

describe("SS-06: disabling a user ends that user's sessions", () => {
  it("SS-06: PATCH status=disabled deletes every session row of the user; the cookies are 401 on A and B; other users keep theirs", async () => {
    const first = await realSession({ role: "user", orgUnitId: ORG, dataScope: "self" });
    const second = await repos.getUserById(first.userId);
    const { createSession } = await import("@forge/identity");
    const twin = await createSession({ type: "user", id: second!.id, name: "twin", role: "user", orgUnitId: ORG, dataScope: "self" });
    const bystander = await realSession({ role: "user", orgUnitId: ORG, dataScope: "self" });
    expect((await sessionOn(b.app, first)).statusCode).toBe(200);
    expect(await rowsOf(first.userId)).toBe(2);
    const res = await disable(first.userId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await rowsOf(first.userId)).toBe(0);
    for (const app of [appA, b.app]) {
      expect((await sessionOn(app, first)).statusCode).toBe(401);
      expect((await sessionOn(app, twin)).statusCode).toBe(401);
      expect((await sessionOn(app, bystander)).statusCode).toBe(200);
    }
    expect(await rowsOf(bystander.userId)).toBe(1);
  });

  it("SS-06: status change and session delete are one transaction (session delete fails -> status stays active, sessions kept)", async () => {
    const victim = await realSession({ role: "user", orgUnitId: ORG, dataScope: "self" });
    const getConnection = pool.getConnection.bind(pool);
    const spy = vi.spyOn(pool, "getConnection").mockImplementation(async () => {
      const conn = await getConnection();
      const original = conn.query.bind(conn) as (...args: unknown[]) => Promise<unknown>;
      return new Proxy(conn, {
        get(target, key, receiver) {
          if (key === "query" || key === "execute") {
            return (sql: unknown, ...rest: unknown[]) => {
              if (typeof sql === "string" && sql.startsWith("DELETE FROM auth_sessions")) return Promise.reject(new Error("injected failure"));
              return key === "query" ? original(sql, ...rest) : (target.execute.bind(target) as (...args: unknown[]) => Promise<unknown>)(sql, ...rest);
            };
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      }) as PoolConnection;
    });
    let status = 0;
    try {
      status = (await disable(victim.userId)).statusCode;
    } finally {
      spy.mockRestore();
    }
    expect(status).toBeGreaterThanOrEqual(500);
    expect((await repos.getUserById(victim.userId))?.status).toBe("active");
    expect(await rowsOf(victim.userId)).toBe(1);
    expect((await sessionOn(appA, victim)).statusCode).toBe(200);
  });

  it("SS-06: a disabled department -> its users' cookies are 401 on A and B (live principal check)", async () => {
    const member = await realSession({ role: "user", orgUnitId: ORG, dataScope: "self" });
    expect((await sessionOn(b.app, member)).statusCode).toBe(200);
    await execute("UPDATE org_units SET status = 'disabled' WHERE id = ?", [ORG]);
    try {
      expect((await sessionOn(appA, member)).statusCode).toBe(401);
      expect((await sessionOn(b.app, member)).statusCode).toBe(401);
    } finally {
      await execute("UPDATE org_units SET status = 'active' WHERE id = ?", [ORG]);
    }
  });
});
