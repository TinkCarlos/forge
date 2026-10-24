import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, one, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// N-03 I-MDL-04 (needs a *_test DB): provider timeoutMs is an integer 1000..600000 (default 120000 when omitted).
// "abc", -1, 0, 1.5, 999, 600001, "120000", null -> 400 CFG-8501, nothing stored.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let providerId = "";
const k = (n: string) => `it-ptb-${n}-${suffix}`;
const BAD: unknown[] = ["abc", -1, 0, 1.5, 999, 600001, "120000", null];
const stored = async (id = providerId) => (await one<{ timeout_ms: number }>("SELECT timeout_ms FROM llm_providers WHERE id = ?", [id]))?.timeout_ms;
const create = (key: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/admin/api/providers", headers, payload: { key, name: "x", protocol: "openai-compatible", baseUrl: "https://llm.example.com/v1", ...extra } });

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ name: "IT ptb", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  providerId = await repos.createProvider({ key: k("base"), name: "IT ptb", protocol: "openai-compatible", baseUrl: "https://llm.example.com/v1", timeoutMs: 120000, createdBy: "01J00000000000000000000001" });
});
afterAll(async () => {
  await execute("DELETE FROM audit_logs WHERE resource_type = 'llm_provider' AND resource_id IN (SELECT id FROM llm_providers WHERE `key` LIKE ?)", [`it-ptb-%-${suffix}`]);
  await execute("DELETE FROM llm_providers WHERE `key` LIKE ?", [`it-ptb-%-${suffix}`]);
  await cleanupRealSessions();
  await app?.close();
});

describe("I-MDL-04 provider timeoutMs bounds", () => {
  it.each(BAD.map((v) => [JSON.stringify(v), v]))("POST timeoutMs=%s -> 400 CFG-8501, nothing created", async (_l, value) => {
    const key = k(`bad${randomBytes(2).toString("hex")}`);
    const res = await create(key, { timeoutMs: value });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("CFG-8501");
    expect(await one("SELECT id FROM llm_providers WHERE `key` = ?", [key])).toBeNull();
  });

  it.each(BAD.map((v) => [JSON.stringify(v), v]))("PATCH timeoutMs=%s -> 400, stored value unchanged", async (_l, value) => {
    const res = await app.inject({ method: "PATCH", url: `/admin/api/providers/${providerId}`, headers, payload: { timeoutMs: value } });
    expect(res.statusCode, res.body).toBe(400);
    expect(await stored()).toBe(120000);
  });

  it("1000 and 600000 pass; omitted -> default 120000", async () => {
    expect((await create(k("min"), { timeoutMs: 1000 })).statusCode).toBe(200);
    const dflt = await create(k("dflt"));
    expect(await stored(dflt.json().id)).toBe(120000);
    expect((await app.inject({ method: "PATCH", url: `/admin/api/providers/${providerId}`, headers, payload: { timeoutMs: 600000 } })).statusCode).toBe(200);
    expect(await stored()).toBe(600000);
  });
});
