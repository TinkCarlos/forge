import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, one, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P2 (architect 4:51, QA 714b3f3 §4 P3-4; needs a *_test DB): dailyQuota is an integer 1..10000000 like
// rateLimitPerMinute (2da2957). Before it was the loose `num` (number|string|null): -1, NaN-producing "abc", 1.5 and
// null (stored as 0 via Number(null)) were accepted. 0 is rejected (whether 0 means "paused" or "unlimited" is
// undocumented). -1, "abc", 1.5, 0, "60" (string, coerceTypes off), null, 10000001 -> 400 CFG-8501, nothing stored.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let appId = "";
const k = (n: string) => `it-adq-${n}-${suffix}`;
const BAD: unknown[] = [-1, "abc", 1.5, 0, "60", null, 10000001, "NaN"];
const stored = async () => (await one<{ daily_quota: number }>("SELECT daily_quota FROM api_apps WHERE id = ?", [appId]))!.daily_quota;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ name: "IT adq", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  appId = await repos.createApiApp({ key: k("base"), name: "IT adq", description: "", ownerOrgUnitId: ROOT, scopes: ["agents:read"], webhookUrl: null, webhookSecretEncrypted: null, rateLimitPerMinute: 60, dailyQuota: 1000, createdBy: "01J00000000000000000000001" });
});
afterAll(async () => {
  await execute("DELETE FROM audit_logs WHERE resource_type = 'api_app' AND resource_id IN (SELECT id FROM api_apps WHERE `key` LIKE ?)", [`it-adq-%-${suffix}`]);
  await execute("DELETE FROM api_apps WHERE `key` LIKE ?", [`it-adq-%-${suffix}`]);
  await cleanupRealSessions();
  await app?.close();
});

describe("P2 dailyQuota bounds", () => {
  it.each(BAD.map((v) => [JSON.stringify(v), v]))("POST dailyQuota=%s -> 400 CFG-8501, no app created", async (_label, value) => {
    const key = k(`bad${randomBytes(2).toString("hex")}`);
    const res = await app.inject({ method: "POST", url: "/admin/api/apps", headers, payload: { key, dailyQuota: value } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("CFG-8501");
    expect(await one("SELECT id FROM api_apps WHERE `key` = ?", [key])).toBeNull();
  });

  it.each(BAD.map((v) => [JSON.stringify(v), v]))("PATCH dailyQuota=%s -> 400, stored value unchanged", async (_label, value) => {
    const res = await app.inject({ method: "PATCH", url: `/admin/api/apps/${appId}`, headers: await configurationHeaders(`/admin/api/apps/${appId}`, headers), payload: { dailyQuota: value } });
    expect(res.statusCode, res.body).toBe(400);
    expect(await stored()).toBe(1000);
  });

  it("valid integers pass: POST 1 and PATCH 10000000; omitted keeps the default 1000", async () => {
    const created = await app.inject({ method: "POST", url: "/admin/api/apps", headers, payload: { key: k("one"), dailyQuota: 1 } });
    expect(created.statusCode, created.body).toBe(200);
    expect((await one<{ r: number }>("SELECT daily_quota AS r FROM api_apps WHERE id = ?", [created.json().id]))!.r).toBe(1);
    const dflt = await app.inject({ method: "POST", url: "/admin/api/apps", headers, payload: { key: k("dflt") } });
    expect((await one<{ r: number }>("SELECT daily_quota AS r FROM api_apps WHERE id = ?", [dflt.json().id]))!.r).toBe(1000);
    expect((await app.inject({ method: "PATCH", url: `/admin/api/apps/${appId}`, headers: await configurationHeaders(`/admin/api/apps/${appId}`, headers), payload: { dailyQuota: 10000000 } })).statusCode).toBe(200);
    expect(await stored()).toBe(10000000);
  });
});
