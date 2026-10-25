import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { config, hashApiKey } from "@forge/core";
import { execute, one, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// P3 (architect on d26f2f4): every 429 carries Retry-After (integer seconds).
// - RPM (OPN-4502): seconds to the end of the current fixed one-minute window, at least 1.
// - daily quota (OPN-4501): seconds to 00:00 of the next day in the DB session time zone (the same CURRENT_DATE()
//   the quota count uses), computed by MySQL; at least 1.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let agentId = "";
let agentKey = "";
let versionId = "";
const appIds: string[] = [];

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string } }).error;
const retryAfter = (res: LightMyRequestResponse) => String(res.headers["retry-after"] ?? "");

async function makeApp(name: string, rateLimitPerMinute: number, dailyQuota: number): Promise<string> {
  const appId = await repos.createApiApp({ key: `it-ra-${name}-${suffix}`, name: `IT ra ${name}`, ownerOrgUnitId: ROOT, scopes: ["agents:read", "runs:create"], rateLimitPerMinute, dailyQuota });
  appIds.push(appId);
  const key = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it", prefix: key.slice(0, 16), keyHash: hashApiKey(key, config.API_KEY_PEPPER), scopes: ["agents:read", "runs:create"] });
  return key;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  agentKey = `it-ra-${suffix}`;
  agentId = await repos.createAgent({ key: agentKey, name: "IT ra", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(agentId, versionId);
  await repos.updateAgent(agentId, { api_enabled: 1 });
});

afterAll(async () => {
  await execute("UPDATE runs SET status = 'cancelled' WHERE agent_id = ? AND status IN ('queued','running')", [agentId]);
  await execute("DELETE FROM audit_logs WHERE resource_type = 'run' AND resource_id IN (SELECT id FROM runs WHERE agent_id = ?)", [agentId]);
  await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  for (const appId of appIds) {
    await execute("DELETE FROM idempotency_keys WHERE scope = ?", [appId]);
    await execute("DELETE FROM api_keys WHERE app_id = ?", [appId]);
    await execute("DELETE FROM api_apps WHERE id = ?", [appId]);
  }
  await app?.close();
});

describe("P3 Retry-After on every 429", () => {
  it("RPM 429 OPN-4502: Retry-After = whole seconds left in the current minute window (1..60)", async () => {
    const key = await makeApp("rpm", 1, 1000);
    const h = { authorization: `Bearer ${key}` };
    let limited: LightMyRequestResponse | null = null;
    let before = 0;
    // limit 1/min: the 2nd call in the same window is 429; a 3rd covers a window flip between the first two.
    for (let i = 0; i < 3 && !limited; i += 1) {
      before = Date.now();
      const res = await app.inject({ method: "GET", url: "/open/v1/agents", headers: h });
      if (res.statusCode === 429) limited = res;
    }
    expect(limited, "no 429 within 3 calls at 1/min").not.toBeNull();
    expect(errorOf(limited!).code).toBe("OPN-4502");
    const value = retryAfter(limited!);
    expect(value).toMatch(/^[1-9][0-9]*$/);
    const expected = Math.ceil((60_000 - (before % 60_000)) / 1000);
    expect(Number(value)).toBeGreaterThanOrEqual(1);
    expect(Number(value)).toBeLessThanOrEqual(60);
    expect(Math.abs(Number(value) - Math.max(1, expected))).toBeLessThanOrEqual(1);
  });

  it("daily quota 429 OPN-4501: Retry-After = seconds to the DB's next midnight (1..86400), runs and invoke", async () => {
    const key = await makeApp("daily", 1000, 1);
    const h = { authorization: `Bearer ${key}` };
    const seed = await app.inject({ method: "POST", url: `/open/v1/agents/${agentKey}/runs`, headers: h, payload: { text: "hi" } });
    expect(seed.statusCode, seed.body).toBe(202);
    for (const url of [`/open/v1/agents/${agentKey}/runs`, `/open/v1/agents/${agentKey}/invoke?wait=1`]) {
      const res = await app.inject({ method: "POST", url, headers: h, payload: { text: "hi" } });
      expect(res.statusCode, res.body).toBe(429);
      expect(errorOf(res).code).toBe("OPN-4501");
      const value = retryAfter(res);
      expect(value, url).toMatch(/^[1-9][0-9]*$/);
      const db = (await one<{ s: number }>("SELECT TIMESTAMPDIFF(SECOND, NOW(), CURRENT_DATE() + INTERVAL 1 DAY) AS s"))!.s;
      expect(Number(value)).toBeGreaterThanOrEqual(1);
      expect(Number(value)).toBeLessThanOrEqual(86_400);
      expect(Math.abs(Number(value) - Math.max(1, Number(db))), url).toBeLessThanOrEqual(5);
    }
    expect((await query<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?", [agentId]))[0]!.n).toBe(1);
  });

  it("daily quota: if the DB cannot report its next midnight (null / error), Retry-After falls back to 3600", async () => {
    const key = await makeApp("fallback", 1000, 1);
    const h = { authorization: `Bearer ${key}` };
    expect((await app.inject({ method: "POST", url: `/open/v1/agents/${agentKey}/runs`, headers: h, payload: { text: "hi" } })).statusCode).toBe(202);
    const spy = vi.spyOn(repos, "secondsUntilNextDbDay");
    try {
      spy.mockResolvedValueOnce(null);
      const nul = await app.inject({ method: "POST", url: `/open/v1/agents/${agentKey}/runs`, headers: h, payload: { text: "hi" } });
      expect(nul.statusCode, nul.body).toBe(429);
      expect(retryAfter(nul)).toBe("3600");
      spy.mockRejectedValueOnce(new Error("db down"));
      const err = await app.inject({ method: "POST", url: `/open/v1/agents/${agentKey}/runs`, headers: h, payload: { text: "hi" } });
      expect(err.statusCode, err.body).toBe(429);
      expect(retryAfter(err)).toBe("3600");
    } finally {
      spy.mockRestore();
    }
  });

  it("non-429 responses carry no Retry-After", async () => {
    const key = await makeApp("none", 1000, 1000);
    const res = await app.inject({ method: "GET", url: "/open/v1/agents", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["retry-after"]).toBeUndefined();
  });
});
