import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, one, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// N-02 I-APP-03 (needs a *_test DB): rateLimitPerMinute is an integer 1..100000 (0 is not documented as "unlimited",
// so it is rejected). -1, "abc", 1.5, 0, "60" (string, coerceTypes off), null, 100001 -> 400 CFG-8501, nothing stored.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let appId = "";
const k = (n: string) => `it-arl-${n}-${suffix}`;
const BAD: unknown[] = [-1, "abc", 1.5, 0, "60", null, 100001];
const stored = async () => (await one<{ rate_limit_per_minute: number }>("SELECT rate_limit_per_minute FROM api_apps WHERE id = ?", [appId]))!.rate_limit_per_minute;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ name: "IT arl", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  appId = await repos.createApiApp({ key: k("base"), name: "IT arl", description: "", ownerOrgUnitId: ROOT, scopes: ["agents:read"], webhookUrl: null, webhookSecretEncrypted: null, rateLimitPerMinute: 60, dailyQuota: 1000, createdBy: "01J00000000000000000000001" });
});
afterAll(async () => {
  await execute("DELETE FROM audit_logs WHERE resource_type = 'api_app' AND resource_id IN (SELECT id FROM api_apps WHERE `key` LIKE ?)", [`it-arl-%-${suffix}`]);
  await execute("DELETE FROM api_apps WHERE `key` LIKE ?", [`it-arl-%-${suffix}`]);
  await cleanupRealSessions();
  await app?.close();
});

describe("I-APP-03 rateLimitPerMinute bounds", () => {
  it.each(BAD.map((v) => [JSON.stringify(v), v]))("POST rateLimitPerMinute=%s -> 400 CFG-8501, no app created", async (_label, value) => {
    const key = k(`bad${randomBytes(2).toString("hex")}`);
    const res = await app.inject({ method: "POST", url: "/admin/api/apps", headers, payload: { key, rateLimitPerMinute: value } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("CFG-8501");
    expect(await one("SELECT id FROM api_apps WHERE `key` = ?", [key])).toBeNull();
  });

  it.each(BAD.map((v) => [JSON.stringify(v), v]))("PATCH rateLimitPerMinute=%s -> 400, stored value unchanged", async (_label, value) => {
    const res = await app.inject({ method: "PATCH", url: `/admin/api/apps/${appId}`, headers: await configurationHeaders(`/admin/api/apps/${appId}`, headers), payload: { rateLimitPerMinute: value } });
    expect(res.statusCode, res.body).toBe(400);
    expect(await stored()).toBe(60);
  });

  it("valid integers pass: POST 1 and PATCH 100000; omitted keeps the default 60", async () => {
    const created = await app.inject({ method: "POST", url: "/admin/api/apps", headers, payload: { key: k("one"), rateLimitPerMinute: 1 } });
    expect(created.statusCode, created.body).toBe(200);
    const dflt = await app.inject({ method: "POST", url: "/admin/api/apps", headers, payload: { key: k("dflt") } });
    expect((await one<{ r: number }>("SELECT rate_limit_per_minute AS r FROM api_apps WHERE id = ?", [dflt.json().id]))!.r).toBe(60);
    expect((await app.inject({ method: "PATCH", url: `/admin/api/apps/${appId}`, headers: await configurationHeaders(`/admin/api/apps/${appId}`, headers), payload: { rateLimitPerMinute: 100000 } })).statusCode).toBe(200);
    expect(await stored()).toBe(100000);
  });
});
