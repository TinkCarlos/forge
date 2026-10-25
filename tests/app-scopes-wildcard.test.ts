import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { config, hashApiKey, type Principal } from "@forge/core";
import { assertScope } from "@forge/governance";
import { sessionCookieValue } from "@forge/identity";
import { execute, one, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P2 (architect on e2d2c5f, item 1): assertScope does not treat `*` as a wildcard and stays that way (external Keys
// must list each scope; admin RBAC's `*` is a separate system). But the app's scopes could be saved as ["*"]
// (input-schema appCreate / appPatch: any string <= 64), so someone could store `*`, think it opens everything and
// get nothing. Saving a scope that contains `*` is now 400 CFG-8501 (details.field scopes.N), nothing stored.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const FAKE_RUN = "01J0000000000000000000ZZZZ";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let baseAppId = "";
const appIds: string[] = [];
const k = (n: string) => `it-wc-${n}-${suffix}`;
const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string; details: { field?: string } | null } }).error;
const appRow = (id: string) => one<{ scopes: string }>("SELECT CAST(scopes_json AS CHAR) AS scopes FROM api_apps WHERE id = ?", [id]);
const keyCount = async (appId: string) => (await query<{ n: number }>("SELECT COUNT(*) AS n FROM api_keys WHERE app_id = ?", [appId]))[0]!.n;
const WILDCARDS: string[][] = [["*"], ["agents:read", "*"], ["runs:*"]];

async function legacyApp(name: string, appScopes: string[], keyScopes: string[]): Promise<{ appId: string; key: string }> {
  const appId = await repos.createApiApp({ key: k(name), name: `IT wc ${name}`, ownerOrgUnitId: ROOT, scopes: appScopes });
  appIds.push(appId);
  const key = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it", prefix: key.slice(0, 16), keyHash: hashApiKey(key, config.API_KEY_PEPPER), scopes: keyScopes });
  return { appId, key };
}
const openCalls = (key: string): Array<[string, () => Promise<LightMyRequestResponse>]> => {
  const h = { authorization: `Bearer ${key}` };
  return [
    ["GET /open/v1/agents", () => app.inject({ method: "GET", url: "/open/v1/agents", headers: h })],
    ["GET /open/v1/agents/:key", () => app.inject({ method: "GET", url: `/open/v1/agents/${k("none")}`, headers: h })],
    ["POST /open/v1/agents/:key/runs", () => app.inject({ method: "POST", url: `/open/v1/agents/${k("none")}/runs`, headers: h, payload: { text: "hi" } })],
    ["POST /open/v1/agents/:key/invoke", () => app.inject({ method: "POST", url: `/open/v1/agents/${k("none")}/invoke?wait=0`, headers: h, payload: { text: "hi" } })],
    ["GET /open/v1/runs/:id", () => app.inject({ method: "GET", url: `/open/v1/runs/${FAKE_RUN}`, headers: h })],
    ["GET /open/v1/runs/:id/result", () => app.inject({ method: "GET", url: `/open/v1/runs/${FAKE_RUN}/result`, headers: h })],
    ["GET /open/v1/runs/:id/events", () => app.inject({ method: "GET", url: `/open/v1/runs/${FAKE_RUN}/events`, headers: h })],
    ["POST /open/v1/runs/:id/cancel", () => app.inject({ method: "POST", url: `/open/v1/runs/${FAKE_RUN}/cancel`, headers: h })],
  ];
};

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ name: "IT wc", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  baseAppId = await repos.createApiApp({ key: k("base"), name: "IT wc", ownerOrgUnitId: ROOT, scopes: ["agents:read"] });
  appIds.push(baseAppId);
});
afterAll(async () => {
  const created = await query<{ id: string }>("SELECT id FROM api_apps WHERE `key` LIKE ?", [`it-wc-%-${suffix}`]);
  for (const { id } of created) {
    await execute("DELETE FROM audit_logs WHERE resource_id = ? OR resource_id IN (SELECT id FROM api_keys WHERE app_id = ?)", [id, id]);
    await execute("DELETE FROM api_keys WHERE app_id = ?", [id]);
    await execute("DELETE FROM api_apps WHERE id = ?", [id]);
  }
  await cleanupRealSessions();
  await app?.close();
});

describe("P2 scopes containing `*` cannot be saved; stored `*` is never a wildcard", () => {
  it.each(WILDCARDS.map((s) => [JSON.stringify(s), s]))("WC-01 POST /admin/api/apps scopes=%s -> 400 CFG-8501, no app created", async (_label, scopes) => {
    const key = k(`p${randomBytes(2).toString("hex")}`);
    const res = await app.inject({ method: "POST", url: "/admin/api/apps", headers, payload: { key, scopes } });
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe("CFG-8501");
    expect(errorOf(res).details?.field).toBe(`scopes.${scopes.findIndex((s) => s.includes("*"))}`);
    expect(errorOf(res).message).toContain("*");
    expect(await one("SELECT id FROM api_apps WHERE `key` = ?", [key])).toBeNull();
  });

  it.each(WILDCARDS.map((s) => [JSON.stringify(s), s]))("WC-01 PATCH /admin/api/apps/:id scopes=%s -> 400 CFG-8501, stored scopes unchanged", async (_label, scopes) => {
    const before = await appRow(baseAppId);
    const res = await app.inject({ method: "PATCH", url: `/admin/api/apps/${baseAppId}`, headers, payload: { scopes } });
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe("CFG-8501");
    expect(await appRow(baseAppId)).toEqual(before);
  });

  it("WC-01 explicit scopes still save (POST and PATCH)", async () => {
    const created = await app.inject({ method: "POST", url: "/admin/api/apps", headers, payload: { key: k("ok"), scopes: ["agents:read", "runs:create"] } });
    expect(created.statusCode, created.body).toBe(200);
    const id = (created.json() as { id: string }).id;
    expect(JSON.parse((await appRow(id))!.scopes)).toEqual(["agents:read", "runs:create"]);
    const patched = await app.inject({ method: "PATCH", url: `/admin/api/apps/${id}`, headers, payload: { scopes: ["runs:read"] } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(JSON.parse((await appRow(id))!.scopes)).toEqual(["runs:read"]);
  });

  it("WC-02 POST /admin/api/apps/:id/keys with scopes [\"*\"] -> 400 CFG-8501, no Key created", async () => {
    const before = await keyCount(baseAppId);
    const res = await app.inject({ method: "POST", url: `/admin/api/apps/${baseAppId}/keys`, headers, payload: { name: "wc", scopes: ["*"] } });
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe("CFG-8501");
    expect(JSON.stringify(res.json())).not.toContain("fsk_");
    expect(await keyCount(baseAppId)).toBe(before);
  });

  it("WC-03 `*` already stored (legacy rows): app [\"*\"] + Key [\"*\"] -> every protected /open route 403 POL-2001", async () => {
    const { key } = await legacyApp("legacy-both", ["*"], ["*"]);
    for (const [name, call] of openCalls(key)) {
      const res = await call();
      expect(res.statusCode, `${name}: ${res.body}`).toBe(403);
      expect(errorOf(res).code, name).toBe("POL-2001");
    }
  });

  it("WC-03 app [\"*\"] + explicit Key, and explicit app + Key [\"*\"] -> 403 POL-2001 (no widening either way)", async () => {
    const appStar = await legacyApp("legacy-app", ["*"], ["agents:read"]);
    const keyStar = await legacyApp("legacy-key", ["agents:read", "runs:create", "runs:read", "runs:cancel"], ["*"]);
    for (const key of [appStar.key, keyStar.key]) {
      const res = await app.inject({ method: "GET", url: "/open/v1/agents", headers: { authorization: `Bearer ${key}` } });
      expect(res.statusCode, res.body).toBe(403);
      expect(errorOf(res).code).toBe("POL-2001");
    }
  });

  it("WC-03 assertScope never treats `*` as a wildcard (unit)", () => {
    const principal = { type: "app", id: "a", name: "a", role: "user", orgUnitId: null, dataScope: "app", appId: "a", scopes: ["*"] } as Principal;
    expect(() => assertScope(principal, "agents:read")).toThrowError(expect.objectContaining({ code: "POL-2001", httpStatus: 403 }));
  });
});
