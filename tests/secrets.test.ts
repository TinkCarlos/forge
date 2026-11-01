import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { revisionTag } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, one, query, repos } from "@forge/store";
import { auditRepo } from "../packages/store/src/repositories/audit.js";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

const ROOT = "01J00000000000000000000000", ORG = `01J${"0".repeat(20)}S01`, OTHER = `01J${"0".repeat(20)}S02`;
const tag = randomUUID();
const created: string[] = [], apps: string[] = [], providers: string[] = [];
let app: Awaited<ReturnType<typeof buildApp>>;
let headers: Record<string, string>, orgHeaders: Record<string, string>, otherHeaders: Record<string, string>, denied: Record<string, string>;
const request = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: object, revision?: number, auth = headers) => app.inject({ method, url: `/admin/api/secrets${url}`, headers: { ...auth, ...(revision ? { "if-match": revisionTag(revision) } : {}) }, ...(body !== undefined ? { payload: body } : {}) });
const create = async (scope: object = { type: "platform" }, value = "synthetic secret", auth = headers) => {
  const r = await request("POST", "", { key: `it-sec-${randomUUID()}`, name: "Test credential", scope, value }, undefined, auth);
  expect(r.statusCode, r.body).toBe(200); created.push(r.json().id); return r.json() as { id: string; revision: number };
};
beforeAll(async () => {
  app = await buildApp({ logger: false }); await app.ready();
  for (const [role, orgUnitId, dataScope, assign] of [
    ["platform_admin", ROOT, "all", (h: Record<string, string>) => { headers = h; }],
    ["platform_admin", ORG, "org", (h: Record<string, string>) => { orgHeaders = h; }],
    ["platform_admin", OTHER, "org", (h: Record<string, string>) => { otherHeaders = h; }],
    ["user", ROOT, "self", (h: Record<string, string>) => { denied = h; }],
  ] as const) {
    const s = await realSession({ role, orgUnitId, dataScope }); assign(sessionHeaders(s, sessionCookieValue(s)));
  }
});
afterAll(async () => {
  vi.restoreAllMocks();
  for (const id of [...apps, ...providers]) {
    const refs = await query<{ to_id: string }>("SELECT to_id FROM resource_references WHERE from_id = ?", [id]); created.push(...refs.map(ref => ref.to_id));
  }
  if (created.length) {
    const inList = created.map(() => "?").join(",");
    await execute(`DELETE FROM resource_references WHERE to_type = 'secret' AND to_id IN (${inList})`, created);
    await execute(`DELETE FROM secret_versions WHERE secret_id IN (${inList})`, created);
    await execute(`DELETE FROM secrets WHERE id IN (${inList})`, created);
  }
  for (const id of apps) await execute("DELETE FROM api_apps WHERE id = ?", [id]);
  for (const id of providers) await execute("DELETE FROM llm_providers WHERE id = ?", [id]);
  await cleanupRealSessions(); await app?.close();
});

describe("SEC03/04 credential lifecycle on real MySQL", () => {
  it("preserves credential bytes, including leading/trailing spaces and newlines", async () => {
    const resourceId = await repos.createApiApp({ key: `it-sec-space-${randomUUID()}`, name: "Whitespace HMAC", scopes: [] }); apps.push(resourceId);
    const s = await create({ type: "resource", resourceType: "api_app", id: resourceId }, "  first\n");
    await repos.updateApiApp(resourceId, { webhook_secret_id: s.id }, { expectedRevision: "system" });
    expect(await repos.resolveCredentialValues("api_app", resourceId, { webhook: s.id })).toEqual({ webhook: "  first\n" });
    expect((await request("POST", `/${s.id}/rotate`, { value: "\n second  " }, 1)).statusCode).toBe(200);
    expect(await repos.resolveCredentialValues("api_app", resourceId, { webhook: s.id })).toEqual({ webhook: "\n second  " });
  });
  it("stores envelope material, returns only metadata, rotates without restart and retains immutable versions", async () => {
    const canary = "never-return-this-canary-credential", s = await create(undefined, canary);
    const detail = await request("GET", `/${s.id}`);
    expect(detail.statusCode, detail.body).toBe(200); expect(detail.headers.etag).toBe('"1"');
    expect(detail.json()).toMatchObject({ id: s.id, revision: 1, activeVersion: 1, referenceCount: 0, scope: { type: "platform" }, versions: [{ version: 1, active: true, keyVersion: "legacy" }] });
    expect(detail.body).not.toContain(canary);
    for (const name of ["ciphertext", "encrypted_dek", "nonce", '"value"', "dek_tag"]) expect(detail.body).not.toContain(name);
    const row = await one<{ ciphertext: Buffer; encrypted_dek: Buffer }>("SELECT ciphertext, encrypted_dek FROM secret_versions WHERE secret_id = ?", [s.id]);
    expect(row!.ciphertext.includes(Buffer.from(canary))).toBe(false); expect(row!.encrypted_dek).toHaveLength(32);
    const rotated = await request("POST", `/${s.id}/rotate`, { value: "replacement" }, 1);
    expect(rotated.statusCode, rotated.body).toBe(200); expect(rotated.json().revision).toBe(2);
    const after = (await request("GET", `/${s.id}`)).json();
    expect(after.activeVersion).toBe(2); expect(after.versions).toHaveLength(2); expect(after.versions[1].active).toBe(false);
    const audit = await query("SELECT details_json FROM audit_logs WHERE resource_id = ?", [s.id]);
    expect(JSON.stringify(audit)).not.toContain(canary); expect(JSON.stringify(audit)).not.toContain("replacement");
  });
  it("serializes concurrent rotations and rolls back a failed audit", async () => {
    const s = await create();
    const writes = await Promise.all(["a", "b"].map(value => request("POST", `/${s.id}/rotate`, { value }, 1)));
    expect(writes.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect((await request("GET", `/${s.id}`)).json().versions).toHaveLength(2);
    const injected = vi.spyOn(auditRepo, "audit").mockRejectedValueOnce(new Error("audit unavailable"));
    const failed = await request("POST", `/${s.id}/rotate`, { value: "must rollback" }, 2); injected.mockRestore();
    expect(failed.statusCode).toBe(500); const after = (await request("GET", `/${s.id}`)).json();
    expect(after.revision).toBe(2); expect(after.versions).toHaveLength(2);
  });
  it("requires conditional writes and validates input/permissions before preconditions", async () => {
    const s = await create();
    expect((await request("POST", `/${s.id}/rotate`, { value: "new" })).statusCode).toBe(428);
    expect((await request("POST", `/${s.id}/rotate`, { value: "env:FORGE_MASTER_KEY" })).statusCode).toBe(400);
    expect((await request("POST", `/${s.id}/rotate`, { value: "x".repeat(32769).replaceAll("x", "中") })).statusCode).toBe(400);
    expect((await request("PATCH", `/${s.id}`, { scope: { type: "org", id: ROOT } }, 1)).statusCode).toBe(400);
    expect((await request("POST", "", {key:"bad-id",name:"bad",scope:{type:"org",id:"中".repeat(26)},value:"synthetic"})).statusCode).toBe(400);
    expect((await request("POST", `/${s.id}/rotate`, { value: "new" }, 1, denied)).statusCode).toBe(403);
    expect((await request("GET", `/${s.id}`, undefined, undefined, {})).statusCode).toBe(401);
    expect((await request("POST", "/unknown/rotate", { value: "new" })).statusCode).toBe(404);
  });
  it("filters list/find in SQL by organization, self and cursor; cannot create a platform secret from org scope", async () => {
    const mine = await create({ type: "org", id: ORG }, "mine", orgHeaders), other = await create({ type: "org", id: OTHER }, "other", otherHeaders);
    const list = (await request("GET", "", undefined, undefined, orgHeaders)).json();
    expect(list.items.some((s: { id: string }) => s.id === mine.id)).toBe(true);
    expect(list.items.some((s: { id: string }) => s.id === other.id)).toBe(false);
    expect((await request("GET", `/${other.id}`, undefined, undefined, orgHeaders)).statusCode).toBe(404);
    expect((await request("POST", "", { key: "bad", name: "bad", scope: { type: "platform" }, value: "bad" }, undefined, orgHeaders)).statusCode).toBe(403);
    const first = (await request("GET", "?limit=1")).json(); expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    const second = (await request("GET", `?limit=1&cursor=${first.nextCursor}`)).json(); expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(await repos.listSecrets({})).toEqual({ items: [], nextCursor: null });
  });
  it("deletes only unused secrets and never exposes soft-deleted metadata", async () => {
    const s = await create();
    expect((await request("DELETE", `/${s.id}`, undefined, 1)).statusCode).toBe(200);
    expect((await request("GET", `/${s.id}`)).statusCode).toBe(404);
    expect((await request("POST", `/${s.id}/rotate`, { value: "new" }, 2)).statusCode).toBe(404);
    expect((await query("SELECT id FROM secret_versions WHERE secret_id = ?", [s.id]))).toHaveLength(1);
  });
});

describe("SEC05/06 scoped bindings and revocation", () => {
  it("concurrent first bindings on different resources all commit without missing-range deadlocks", async () => {
    const results = await Promise.allSettled(Array.from({length:30}, (_, i) => i % 2
      ? repos.createApiApp({key:`it-sec-concurrent-${randomUUID()}`,name:"Concurrent app",scopes:[],webhookSecret:"synthetic-value"}).then(id => { apps.push(id); return id; })
      : repos.createProvider({key:`it-sec-concurrent-${randomUUID()}`,name:"Concurrent provider",protocol:"openai-compatible",baseUrl:"https://llm.example",apiKey:"synthetic-value",headers:{"X-Token":"synthetic-header"}}).then(id => { providers.push(id); return id; })));
    expect(results.filter(r => r.status === "rejected")).toEqual([]);
  });
  it("checks the combined header count, rolls back 101 fields and accepts 100", async () => {
    const shared = await create(undefined,"shared-header");
    const refs = Object.fromEntries(Array.from({length:100},(_,i) => [`x-${i}`,shared.id]));
    const key = `it-sec-overflow-${randomUUID()}`;
    await expect(repos.createProvider({key,name:"overflow",protocol:"openai-compatible",baseUrl:"https://llm.example",headers:{"x-inline":"inline"},headerSecretRefs:refs})).rejects.toMatchObject({code:"CFG-8501"});
    expect(await repos.getProviderByKey(key)).toBeNull();
    delete refs["x-99"];
    const id = await repos.createProvider({key,name:"limit",protocol:"openai-compatible",baseUrl:"https://llm.example",headers:{"x-inline":"inline"},headerSecretRefs:refs}); providers.push(id);
    expect(Object.keys((await repos.getProviderById(id))!.header_secret_refs_json as object)).toHaveLength(100);
    await expect(repos.updateProvider(id,{headers_json:{"x-bad":"bad\x7fvalue"}},{expectedRevision:1})).rejects.toMatchObject({code:"CFG-8501"});
  });
  it("serializes a new binding against deletion and rolls back the loser", async () => {
    for (let n=0;n<5;n++) {
      const id = await repos.createApiApp({key:`it-sec-race-${randomUUID()}`,name:"Race",scopes:[]}); apps.push(id);
      const s = await create();
      const [bind,remove] = await Promise.all([
        app.inject({method:"PATCH",url:`/admin/api/apps/${id}`,headers:{...headers,"if-match":'"1"'},payload:{webhookSecretId:s.id}}),
        request("DELETE",`/${s.id}`,undefined,1),
      ]);
      if (bind.statusCode === 200) { expect(remove.statusCode).toBe(409); expect(await repos.resolveCredentialValues("api_app",id,{webhook:s.id})).toEqual({webhook:"synthetic secret"}); }
      else { expect(remove.statusCode).toBe(200); expect(bind.statusCode).toBe(404); expect((await repos.getApiApp(id))!.webhook_secret_id).toBeNull(); }
    }
  });
  it("keeps organization use exact even when the destination is a child organization", async () => {
    const child = `01J${"0".repeat(20)}S03`;
    await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, 'Child credential org', ?)",[child,ORG,`it-child-${tag}`,`/it-child-${tag}/`]);
    try {
      const id = await repos.createApiApp({key:`it-sec-child-${randomUUID()}`,name:"Child",scopes:[],ownerOrgUnitId:child}); apps.push(id);
      const s = await create({type:"org",id:ORG},"org-specific");
      await expect(repos.updateApiApp(id,{webhook_secret_id:s.id},{expectedRevision:1})).rejects.toMatchObject({code:"POL-2001"});
      const own = await create({type:"resource",resourceType:"api_app",id},"own");
      const other = await repos.createApiApp({key:`it-sec-other-${randomUUID()}`,name:"Same org other resource",scopes:[],ownerOrgUnitId:child}); apps.push(other);
      await expect(repos.updateApiApp(other,{webhook_secret_id:own.id},{expectedRevision:1})).rejects.toMatchObject({code:"POL-2001"});
    } finally { await execute("DELETE FROM org_units WHERE id = ?",[child]); }
  });
  it("uses the bound current value, refuses a different resource/organization and blocks deletion", async () => {
    const resourceId = await repos.createApiApp({ key: `it-sec-app-${tag}`, name: "Binding target", scopes: [], ownerOrgUnitId: ROOT }); apps.push(resourceId);
    const resource = (await repos.getCredentialResource("api_app", resourceId))!;
    const s = await create({ type: "resource", resourceType: "api_app", id: resourceId }, "first");
    await repos.updateApiApp(resourceId, { name: "Binding target" }, { expectedRevision: "system", afterWrite: conn => repos.bindSecretReferences(resource, { webhook: s.id }, conn) });
    expect(await repos.resolveCredentialValues("api_app", resourceId, { webhook: s.id })).toEqual({ webhook: "first" });
    expect((await request("GET", `/${s.id}`)).json()).toMatchObject({ referenceCount: 1, references: [{ resourceId, bindingKey: "webhook" }] });
    expect((await request("DELETE", `/${s.id}`, undefined, 1)).statusCode).toBe(409);
    await request("POST", `/${s.id}/rotate`, { value: "second" }, 1);
    expect(await repos.resolveCredentialValues("api_app", resourceId, { webhook: s.id })).toEqual({ webhook: "second" });
    const disabled = await request("PATCH", `/${s.id}`, { status: "disabled" }, 2); expect(disabled.statusCode).toBe(200);
    await expect(repos.resolveCredentialValues("api_app", resourceId, { webhook: s.id })).rejects.toMatchObject({ code: "SYS-9002" });
    await request("POST", `/${s.id}/rotate`, { value: "third" }, 3);
    expect((await request("GET", `/${s.id}`)).json().status).toBe("disabled");
    const wrong = await create({ type: "org", id: OTHER }, "wrong");
    await expect(repos.updateApiApp(resourceId, { name: "must rollback" }, { expectedRevision: "system", afterWrite: conn => repos.bindSecretReferences(resource, { webhook: wrong.id }, conn) })).rejects.toMatchObject({ code: "POL-2001" });
    expect((await repos.getApiApp(resourceId))!.name).toBe("Binding target");
  });
});
