import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { config, hashApiKey } from "@forge/core";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// P2 (architect on d26f2f4): /open runs and invoke checked the daily quota before resolving the Idempotency-Key, so
// replaying a request that already succeeded returned 429 OPN-4501 once the day's quota was used up, although a
// replay creates nothing. Now the key is resolved first: a replay returns the stored response (same runId, no new
// Run) even with the quota used up; a new key (or no key) on a used-up quota is still 429 and leaves no
// idempotency row. Replays on a quota that is not used up behave as before.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let agentId = "";
let agentKey = "";
let versionId = "";
const appIds: string[] = [];

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string } }).error;
const runCount = async (appId: string) => (await query<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE app_id = ?", [appId]))[0]!.n;
const idemRows = async (appId: string, key: string) =>
  (await query<{ n: number }>("SELECT COUNT(*) AS n FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?", [appId, key]))[0]!.n;
const exhaust = async (appId: string) => execute("UPDATE api_apps SET daily_quota = GREATEST(1, (SELECT COUNT(*) FROM runs WHERE app_id = ? AND created_at >= CURRENT_DATE())) WHERE id = ?", [appId, appId]);

async function makeApp(name: string): Promise<{ appId: string; key: string }> {
  const appId = await repos.createApiApp({ key: `it-iq-${name}-${suffix}`, name: `IT iq ${name}`, ownerOrgUnitId: ROOT, scopes: ["runs:create"], dailyQuota: 1000, rateLimitPerMinute: 1000 });
  appIds.push(appId);
  const key = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it", prefix: key.slice(0, 16), keyHash: hashApiKey(key, config.API_KEY_PEPPER), scopes: ["runs:create"] });
  return { appId, key };
}

const MODES = [
  { mode: "runs", url: () => `/open/v1/agents/${agentKey}/runs` },
  { mode: "invoke", url: () => `/open/v1/agents/${agentKey}/invoke?wait=0` },
] as const;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  agentKey = `it-iq-${suffix}`;
  agentId = await repos.createAgent({ key: agentKey, name: "IT iq", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
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

const POSITIVE_INT = /^[1-9][0-9]*$/;

describe("P2 Idempotency-Key is resolved before the daily quota (/open runs + invoke)", () => {
  for (const { mode, url } of MODES) {
    it(`IDQ-01 ${mode}: replay with quota NOT used up is unchanged (200 + Idempotency-Replayed, same body, no new Run)`, async () => {
      const { appId, key } = await makeApp(`ok-${mode}`);
      const h = { authorization: `Bearer ${key}`, "idempotency-key": `idem-ok-${suffix}` };
      const first = await app.inject({ method: "POST", url: url(), headers: h, payload: { text: "hi" } });
      expect(first.statusCode, first.body).toBe(202);
      const replay = await app.inject({ method: "POST", url: url(), headers: h, payload: { text: "hi" } });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(replay.json()).toEqual(first.json());
      expect(await runCount(appId)).toBe(1);
    });

    it(`IDQ-01 ${mode}: quota used up + replay of an existing key -> same response as a normal replay (status, body, runId), not 429, no new Run`, async () => {
      const { appId, key } = await makeApp(`replay-${mode}`);
      const h = { authorization: `Bearer ${key}`, "idempotency-key": `idem-old-${suffix}` };
      const first = await app.inject({ method: "POST", url: url(), headers: h, payload: { text: "hi" } });
      expect(first.statusCode, first.body).toBe(202);
      const before = await app.inject({ method: "POST", url: url(), headers: h, payload: { text: "hi" } });
      await exhaust(appId);
      const replay = await app.inject({ method: "POST", url: url(), headers: h, payload: { text: "hi" } });
      expect(replay.statusCode, replay.body).toBe(before.statusCode);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(replay.json()).toEqual(first.json());
      expect((replay.json() as { runId: string }).runId).toBe((first.json() as { runId: string }).runId);
      expect(await runCount(appId)).toBe(1);
    });

    it(`IDQ-02 ${mode}: quota used up + new key (and no key) -> still 429 OPN-4501 with Retry-After, no Run, no idempotency row left`, async () => {
      const { appId, key } = await makeApp(`new-${mode}`);
      const seed = await app.inject({ method: "POST", url: url(), headers: { authorization: `Bearer ${key}` }, payload: { text: "hi" } });
      expect(seed.statusCode, seed.body).toBe(202);
      await exhaust(appId);
      const fresh = `idem-new-${suffix}`;
      const res = await app.inject({ method: "POST", url: url(), headers: { authorization: `Bearer ${key}`, "idempotency-key": fresh }, payload: { text: "hi" } });
      expect(res.statusCode, res.body).toBe(429);
      expect(errorOf(res).code).toBe("OPN-4501");
      expect(String(res.headers["retry-after"] ?? "")).toMatch(POSITIVE_INT);
      expect(await idemRows(appId, fresh)).toBe(0);
      const noKey = await app.inject({ method: "POST", url: url(), headers: { authorization: `Bearer ${key}` }, payload: { text: "hi" } });
      expect(noKey.statusCode, noKey.body).toBe(429);
      expect(errorOf(noKey).code).toBe("OPN-4501");
      expect(String(noKey.headers["retry-after"] ?? "")).toMatch(POSITIVE_INT);
      expect(await runCount(appId)).toBe(1);
    });

    it(`IDQ-03 ${mode}: one Run left, N replays do not use it up; the first new key still succeeds, the next is 429`, async () => {
      const { appId, key } = await makeApp(`left1-${mode}`);
      await execute("UPDATE api_apps SET daily_quota = 2 WHERE id = ?", [appId]);
      const auth = { authorization: `Bearer ${key}` };
      const h = { ...auth, "idempotency-key": `idem-a-${suffix}` };
      const first = await app.inject({ method: "POST", url: url(), headers: h, payload: { text: "hi" } });
      expect(first.statusCode, first.body).toBe(202);
      for (let i = 0; i < 5; i += 1) {
        const replay = await app.inject({ method: "POST", url: url(), headers: h, payload: { text: "hi" } });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json()).toEqual(first.json());
      }
      expect(await runCount(appId)).toBe(1);
      const fresh = await app.inject({ method: "POST", url: url(), headers: { ...auth, "idempotency-key": `idem-b-${suffix}` }, payload: { text: "hi" } });
      expect(fresh.statusCode, fresh.body).toBe(202);
      expect((fresh.json() as { runId: string }).runId).not.toBe((first.json() as { runId: string }).runId);
      expect(await runCount(appId)).toBe(2);
      const over = await app.inject({ method: "POST", url: url(), headers: { ...auth, "idempotency-key": `idem-c-${suffix}` }, payload: { text: "hi" } });
      expect(over.statusCode, over.body).toBe(429);
      expect(errorOf(over).code).toBe("OPN-4501");
      expect(await runCount(appId)).toBe(2);
    });

    it(`IDQ-04 ${mode}: same key + different body is 409 OPN-4503 as before, and stays 409 (not 429) with the quota used up`, async () => {
      const { appId, key } = await makeApp(`diff-${mode}`);
      const h = { authorization: `Bearer ${key}`, "idempotency-key": `idem-diff-${suffix}` };
      const first = await app.inject({ method: "POST", url: url(), headers: h, payload: { text: "hi" } });
      expect(first.statusCode, first.body).toBe(202);
      const conflict = await app.inject({ method: "POST", url: url(), headers: h, payload: { text: "bye" } });
      expect(conflict.statusCode, conflict.body).toBe(409);
      expect(errorOf(conflict).code).toBe("OPN-4503");
      await exhaust(appId);
      const conflictUsedUp = await app.inject({ method: "POST", url: url(), headers: h, payload: { text: "bye" } });
      expect(conflictUsedUp.statusCode, conflictUsedUp.body).toBe(409);
      expect(errorOf(conflictUsedUp).code).toBe("OPN-4503");
      expect(conflictUsedUp.json()).toMatchObject({ error: { code: "OPN-4503", message: errorOf(conflict).message } });
      expect(await runCount(appId)).toBe(1);
    });
  }
});
