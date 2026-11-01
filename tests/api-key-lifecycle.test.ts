import { configurationHeaders } from "./helpers/configuration-headers.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import Ajv from "ajv";
import { API_APP_LIST_RESPONSE, API_KEY_LIST_RESPONSE } from "@forge/contracts";
import { buildApp } from "../apps/api/src/app.js";
import { sessionCookieValue } from "@forge/identity";
import { execute, one, query, repos } from "@forge/store";
import { auditRepo } from "../packages/store/src/repositories/audit.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

const ROOT = "01J00000000000000000000000";
const ajv = new Ajv({ strict: false });
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const validKeyList = ajv.compile(API_KEY_LIST_RESPONSE);
const validAppList = ajv.compile(API_APP_LIST_RESPONSE);
let app: FastifyInstance;
let appId: string;
let headers: Record<string, string>;
let userHeaders: Record<string, string>;
let outsideHeaders: Record<string, string>;
const create = async (body: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/admin/api/apps/${appId}/keys`, headers: await configurationHeaders(`/admin/api/apps/${appId}/keys`, headers), payload: body });
const rotate = (id: string, key = randomUUID(), body: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/admin/api/api-keys/${id}/rotate`, headers: { ...headers, "idempotency-key": key }, payload: body });
const revoke = (id: string) => app.inject({ method: "POST", url: `/admin/api/api-keys/${id}/revoke`, headers });
const authenticate = (key: string) => app.inject({ method: "GET", url: "/open/v1/agents", headers: { authorization: `Bearer ${key}` } });
const keyRow = (id: string) => one<{ status: string; expires_at: Date | null; last_used_at: Date | null; key_hash: string }>("SELECT status, expires_at, last_used_at, key_hash FROM api_keys WHERE id = ?", [id]);
const countKeys = async () => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM api_keys WHERE app_id = ?", [appId]))!.n);

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const [role, orgUnitId, assign] of [
    ["platform_admin", ROOT, (h: Record<string, string>) => { headers = h; }],
    ["user", ROOT, (h: Record<string, string>) => { userHeaders = h; }],
    ["org_admin", "01J00000000000000000999001", (h: Record<string, string>) => { outsideHeaders = h; }],
  ] as const) {
    const s = await realSession({ role, orgUnitId, dataScope: role === "platform_admin" ? "all" : "org" });
    assign(sessionHeaders(s, sessionCookieValue(s)));
  }
  appId = await repos.createApiApp({ key: `it-key-${randomUUID()}`, name: "Key lifecycle test", ownerOrgUnitId: ROOT, scopes: ["agents:read"] });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await execute("DELETE FROM idempotency_keys WHERE scope IN (SELECT CONCAT('apikey.rotate:', id) FROM api_keys WHERE app_id = ?)", [appId]);
  await execute("DELETE FROM audit_logs WHERE resource_id IN (SELECT id FROM api_keys WHERE app_id = ?)", [appId]);
  await execute("DELETE FROM api_apps WHERE id = ?", [appId]);
  await cleanupRealSessions();
  await app?.close();
});

describe("FR-OP-02 API Key lifecycle on real MySQL", () => {
  it("creates with a timezone-aware expiry; lists only metadata and updates last use", async () => {
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    const response = await create({ name: "release", expiresAt });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const key = response.json();
    expect(key.expiresAt).toBe(expiresAt);
    expect((await keyRow(key.id))!.key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await authenticate(key.key)).statusCode).toBe(200);
    expect((await keyRow(key.id))!.last_used_at).toBeInstanceOf(Date);
    const listed = await app.inject({ method: "GET", url: `/admin/api/apps/${appId}/keys`, headers });
    expect(listed.body).not.toContain(key.key);
    expect(listed.body).not.toContain("key_hash");
    expect(validKeyList(listed.json()), JSON.stringify(validKeyList.errors)).toBe(true);
    expect(listed.json().items.find((r: { id: string }) => r.id === key.id).expires_at).toBe(expiresAt);
    const audit = await one<{ details_json: unknown }>("SELECT details_json FROM audit_logs WHERE resource_id = ? AND action = 'apikey.create'", [key.id]);
    expect(JSON.stringify(audit)).not.toContain(key.key);
    expect(audit).not.toBeNull();
  });

  it.each(["yesterday", "2026-02-30T12:00:00Z", "2026-10-31T12:00:00", "2000-01-01T00:00:00Z", 42, ""])('rejects invalid/past expiry %s without issuing a key', async (expiresAt) => {
    const before = await countKeys();
    const res = await create({ expiresAt });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("CFG-8501");
    expect(await countKeys()).toBe(before);
  });

  it("expires exactly at the cutoff and revokes immediately, idempotently", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const key = (await create({ expiresAt: expiresAt.toISOString() })).json();
    const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt.getTime());
    try { expect((await authenticate(key.key)).statusCode).toBe(401); } finally { clock.mockRestore(); }
    expect((await authenticate(key.key)).statusCode).toBe(200);
    expect((await revoke(key.id)).statusCode).toBe(200);
    expect((await authenticate(key.key)).statusCode).toBe(401);
    expect((await revoke(key.id)).statusCode).toBe(200);
    const audit = await query("SELECT id FROM audit_logs WHERE action = 'apikey.revoke' AND resource_id = ?", [key.id]);
    expect(audit).toHaveLength(1);
    expect((await rotate(key.id)).statusCode).toBe(409);
  });

  it("serializes concurrent retries, emits one secret, and rejects changed retry parameters", async () => {
    const old = (await create()).json();
    const retry = randomUUID();
    const before = await countKeys();
    const responses = await Promise.all([rotate(old.id, retry), rotate(old.id, retry), rotate(old.id, retry)]);
    for (const r of responses) expect(r.statusCode, r.body).toBe(200);
    const results = responses.map(r => r.json());
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    expect(results.filter(r => r.secretAvailable && r.key)).toHaveLength(1);
    expect(results.filter(r => !r.secretAvailable && r.key === undefined)).toHaveLength(2);
    expect(await countKeys()).toBe(before + 1);
    expect((await authenticate(old.key)).statusCode).toBe(401);
    const issued = results.find(r => r.key)!;
    expect((await authenticate(issued.key)).statusCode).toBe(200);
    const persisted = await query("SELECT response_json FROM idempotency_keys WHERE scope = ?", [`apikey.rotate:${old.id}`]);
    expect(JSON.stringify(persisted)).not.toContain(issued.key);
    expect((await rotate(old.id, retry, { overlapSeconds: 1 })).statusCode).toBe(409);
    expect((await rotate(old.id)).statusCode).toBe(409);
    expect((await rotate(old.id, retry)).json()).toEqual({ ...issued, secretAvailable: false, key: undefined });
  });

  it("rotates different keys concurrently without deadlocks", async () => {
    const keys = [];
    for (let i = 0; i < 10; i++) keys.push((await create()).json());
    const results = await Promise.all(keys.map(k => rotate(k.id)));
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    expect(new Set(results.map(r => r.json().id)).size).toBe(10);
  });

  it("keeps the overlap bounded by old expiry and preserves the new key expiry and scopes", async () => {
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    const old = (await create({ expiresAt })).json();
    const result = (await rotate(old.id, randomUUID(), { overlapSeconds: 60 })).json();
    expect(result.expiresAt).toBe(expiresAt);
    expect(result.oldKeyStatus).toBe("active");
    expect(new Date(result.oldKeyExpiresAt).getTime()).toBeLessThan(Date.now() + 60_001);
    expect(new Date(result.oldKeyExpiresAt).getTime()).toBeGreaterThan(Date.now() + 55_000);
    expect((await authenticate(old.key)).statusCode).toBe(200);
    expect((await authenticate(result.key)).statusCode).toBe(200);
    const clock = vi.spyOn(Date, "now").mockReturnValue(new Date(result.oldKeyExpiresAt).getTime());
    try {
      expect((await authenticate(old.key)).statusCode).toBe(401);
      expect((await authenticate(result.key)).statusCode).toBe(200);
    } finally { clock.mockRestore(); }
    const shorter = (await create({ expiresAt })).json();
    const bounded = (await rotate(shorter.id, randomUUID(), { overlapSeconds: 86400 })).json();
    expect(bounded.oldKeyExpiresAt).toBe(expiresAt);
    const scopes = await one<{ scopes_json: unknown }>("SELECT scopes_json FROM api_keys WHERE id = ?", [result.id]);
    expect(scopes!.scopes_json).toEqual(["agents:read"]);
  });

  it("rolls back create, revoke and rotation when audit fails, with safe retry", async () => {
    let before = await countKeys();
    vi.spyOn(auditRepo, "audit").mockRejectedValueOnce(new Error("test audit unavailable"));
    expect((await create()).statusCode).toBe(500);
    expect(await countKeys()).toBe(before);
    vi.restoreAllMocks();
    const old = (await create()).json();
    vi.spyOn(auditRepo, "audit").mockRejectedValueOnce(new Error("test audit unavailable"));
    expect((await revoke(old.id)).statusCode).toBe(500);
    expect((await authenticate(old.key)).statusCode).toBe(200);
    vi.restoreAllMocks();
    before = await countKeys();
    const retry = randomUUID();
    vi.spyOn(auditRepo, "audit").mockRejectedValueOnce(new Error("test audit unavailable"));
    expect((await rotate(old.id, retry)).statusCode).toBe(500);
    expect(await countKeys()).toBe(before);
    expect((await authenticate(old.key)).statusCode).toBe(200);
    expect(await repos.getIdempotency(`apikey.rotate:${old.id}`, retry)).toBeNull();
    vi.restoreAllMocks();
    expect((await rotate(old.id, retry)).json().secretAvailable).toBe(true);
  });

  it("enforces permission, org scope, CSRF, missing keys and strict inputs", async () => {
    const key = (await create()).json();
    const writable = await app.inject({ method: "GET", url: `/admin/api/apps/${appId}/keys`, headers });
    const readonly = await app.inject({ method: "GET", url: `/admin/api/apps/${appId}/keys`, headers: outsideHeaders });
    expect(writable.json().canManage).toBe(true);
    expect(readonly.statusCode).toBe(200);
    expect(readonly.json().canManage).toBe(false);
    const apps = await app.inject({ method: "GET", url: "/admin/api/apps", headers: outsideHeaders });
    expect(validAppList(apps.json()), JSON.stringify(validAppList.errors)).toBe(true);
    expect(apps.json().items.find((a: { id: string }) => a.id === appId).canManage).toBe(false);
    for (const action of ["rotate", "revoke"]) {
      const url = `/admin/api/api-keys/${key.id}/${action}`;
      for (const h of [userHeaders, outsideHeaders, { ...headers, "x-csrf-token": "wrong" }]) {
        expect((await app.inject({ method: "POST", url, headers: h, payload: {} })).statusCode).toBe(403);
      }
      expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: `/admin/api/api-keys/missing/${action}`, headers, payload: {} })).statusCode).toBe(404);
    }
    const url = `/admin/api/api-keys/${key.id}/rotate`;
    expect((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(400);
    for (const overlapSeconds of [-1, 86401, 1.5, "60"]) expect((await rotate(key.id, randomUUID(), { overlapSeconds })).statusCode).toBe(400);
    expect((await rotate(key.id, randomUUID(), { scopes: ["runs:create"] })).statusCode).toBe(400);
    expect((await keyRow(key.id))!.status).toBe("active");
  });
});
