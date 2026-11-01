import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config, hashPassword, revisionTag } from "@forge/core";
import { createSession, loginLocal, sessionCookieValue, toPrincipal } from "@forge/identity";
import { execute, pool, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

const suffix = randomBytes(5).toString("hex");
const ROOT = "01J00000000000000000000000";
const ADMIN = "01J00000000000000000000001";
const ids: string[] = [];
const runFixtures: Array<{runId:string;threadId:string}> = [];
const password = "  Lifecycle!2026  ";
let app: FastifyInstance;
let headers: Record<string, string>;
const user = async (id: string) => (await repos.getUserById(id))!;
const tag = async (id: string, h = headers) => ({ ...h, "if-match": revisionTag((await user(id)).revision) });
const makeUser = async (name: string, extra = {}) => {
  const id = await repos.createUser({ email: `${name}-${suffix}@forge.local`, username: `${name}-${suffix}`, displayName: `Life ${name}`, orgUnitId: ROOT, passwordHash: hashPassword(password), ...extra });
  ids.push(id); return id;
};
const request = (method: "POST" | "PATCH" | "DELETE" | "PUT", url: string, h: Record<string, string>, payload?: Record<string, unknown>) => app.inject({ method, url, headers: h, ...(payload === undefined ? {} : { payload }) });
const cookieFor = async (id: string) => {
  const session = await createSession(toPrincipal(await user(id)));
  return { cookie: `forge_session=${sessionCookieValue(session)}`, "x-csrf-token": session.csrfToken };
};
beforeAll(async () => { app = await buildApp({ logger: false }); await app.ready(); headers = await cookieFor(ADMIN); });
afterAll(async () => {
  for (const fixture of runFixtures) { await execute("DELETE FROM runs WHERE id = ?",[fixture.runId]); await execute("DELETE FROM threads WHERE id = ?",[fixture.threadId]); }
  for (const id of ids) { await execute("DELETE FROM audit_logs WHERE actor_id = ? OR resource_id = ?", [id, id]); await execute("DELETE FROM users WHERE id = ?", [id]); }
  await app?.close();
});

describe("U01/U02 identity lifecycle", () => {
  it("creates, edits identifiers/department and accepts exact password via username or email", async () => {
    const email = `create-${suffix}@forge.local`, username = `create-${suffix}`;
    const created = await request("POST", "/admin/api/users", headers, { email, username, displayName: "Created", password, orgUnitId: ROOT });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string; ids.push(id);
    for (const identifier of [username, email]) {
      const res = await request("POST", "/auth/local/login", {}, { email: identifier, password });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ id, revision: 1 });
      expect(JSON.stringify(res.json())).not.toContain("authenticationRevision");
    }
    expect((await request("POST", "/auth/local/login", {}, { email, password: password.trim() })).statusCode).toBe(401);
    const patch = await request("PATCH", `/admin/api/users/${id}`, await tag(id), { username: `edited-${suffix}`, email: `edited-${suffix}@forge.local`, displayName: "Edited", orgUnitId: null });
    expect(patch.statusCode).toBe(200);
    expect(await user(id)).toMatchObject({ username: `edited-${suffix}`, display_name: "Edited", org_unit_id: null, data_scope: "self" });
    const detail = await app.inject({ url: `/admin/api/users/${id}`, headers });
    expect(detail.json()).toMatchObject({ has_local_password: true, can_manage: true });
    expect(JSON.stringify(detail.json())).not.toMatch(/password_hash|scrypt\$/);
  });

  it("delete revokes all sessions and releases aliases without inheriting the old identity", async () => {
    const id = await makeUser("reuse", { idpSubject: `old-sub-${suffix}` });
    const old = await cookieFor(id), second = await cookieFor(id), before = await user(id);
    const threadId = await repos.createThread({agentId:"01J00000000000000000000006",orgUnitId:ROOT,subjectType:"user",subjectId:id});
    const runId = await repos.createRun({threadId,agentId:"01J00000000000000000000006",agentVersionId:"01J00000000000000000000007",orgUnitId:ROOT,subjectType:"user",subjectId:id,input:{text:"old self ownership fixture"},status:"succeeded"});
    runFixtures.push({runId,threadId});
    const res = await request("DELETE", `/admin/api/users/${id}`, await tag(id));
    expect(res.statusCode).toBe(200);
    expect(await user(id)).toMatchObject({ status: "deleted", password_hash: null, idp_subject: before.idp_subject });
    for (const h of [old, second]) expect((await app.inject({ url: "/auth/session", headers: h })).statusCode).toBe(401);
    expect((await app.inject({ url: `/admin/api/users/${id}`, headers })).statusCode).toBe(404);
    const replacement = await request("POST", "/admin/api/users", headers, { email: before.email, username: before.username, password });
    expect(replacement.statusCode).toBe(200);
    const freshId = replacement.json().id as string; ids.push(freshId);
    expect(freshId).not.toBe(id);
    expect(await user(freshId)).toMatchObject({ role: "user", data_scope: "self", idp_subject: null });
    const freshHeaders = await cookieFor(freshId);
    expect((await app.inject({url:`/admin/api/runs/${runId}`,headers:freshHeaders})).statusCode).toBe(404);
    await repos.bindUserIdentity(freshId,before.idp_subject,"https://identity.reuse.test",{expectedRevision:1,audit:{actorType:"user",actorId:ADMIN,action:"user.sso.bind",resourceType:"user",resourceId:freshId,orgUnitId:null}});
    expect((await user(id)).idp_subject).toBeNull();
    expect((await user(freshId)).role).toBe("user");
    expect((await app.inject({url:`/admin/api/runs/${runId}`,headers:await cookieFor(freshId)})).statusCode).toBe(404);
    const page = await app.inject({ url: `/admin/api/users?q=${encodeURIComponent(before.email)}`, headers });
    expect(page.json().items.map((u: { id: string }) => u.id)).toEqual([freshId]);
  });

  it("password reset and self change invalidate every old session and old verification", async () => {
    const id = await makeUser("password"), row = await user(id);
    const staleVerification = await loginLocal(row.username, password);
    const old = await cookieFor(id), second = await cookieFor(id);
    expect((await request("POST", `/admin/api/users/${id}/password`, await tag(id), { password: "Reset!2026" })).statusCode).toBe(200);
    await expect(createSession(staleVerification)).rejects.toMatchObject({ code: "AUTH-1001" });
    for (const h of [old, second]) expect((await app.inject({ url: "/auth/session", headers: h })).statusCode).toBe(401);
    const current = await cookieFor(id);
    expect((await request("POST", "/auth/password", current, { currentPassword: "Reset!2026", newPassword: "Changed!2026" })).statusCode).toBe(428);
    const selfHeaders = await tag(id, current);
    expect((await request("POST", "/auth/password", selfHeaders, { currentPassword: "bad", newPassword: "Changed!2026" })).statusCode).toBe(400);
    const changed = await request("POST", "/auth/password", selfHeaders, { currentPassword: "Reset!2026", newPassword: "Changed!2026" });
    expect(changed.statusCode).toBe(200);
    expect(String(changed.headers["set-cookie"])).toContain("forge_session=;");
    expect((await app.inject({ url: "/auth/session", headers: current })).statusCode).toBe(401);
    expect((await loginLocal(row.username, "Changed!2026")).id).toBe(id);
    const audits = await query<{ details_json: unknown }>("SELECT details_json FROM audit_logs WHERE resource_id = ?", [id]);
    expect(JSON.stringify(audits)).not.toMatch(/Reset!2026|Changed!2026|scrypt\$/);
  });

  it("concurrent account writers acquire exclusive mutex without lock upgrades", async () => {
    const targets = await Promise.all(Array.from({ length: 12 }, (_, n) => makeUser(`parallel${n}`)));
    const results = await Promise.all(targets.map(async id => request("PATCH", `/admin/api/users/${id}`, await tag(id), { displayName: `Saved ${id}` })));
    expect(results.map(r => r.statusCode)).toEqual(targets.map(() => 200));
  });

  it("does not let an org administrator take over a wider-scope account", async () => {
    const actor = await makeUser("org-admin", { role: "org_admin", dataScope: "org" });
    const target = await makeUser("wide", { dataScope: "all" });
    const h = await cookieFor(actor);
    for (const [method, path, body] of [["PATCH", "", { username: `take-${suffix}` }], ["POST", "/password", { password: "Takeover!2026" }], ["DELETE", "", undefined]] as const) {
      expect((await request(method, `/admin/api/users/${target}${path}`, await tag(target, h), body)).statusCode).toBe(403);
    }
    expect((await user(target)).username).not.toBe(`take-${suffix}`);
  });

  it("rejects reserved accent aliases and deletes even when a legacy tombstone is occupied", async () => {
    const target = await makeUser("tombstone");
    const legacy = await makeUser("legacy");
    await execute("UPDATE users SET username = ?, email = ? WHERE id = ?", [`__déléted__${target}`, `${target}@déléted.forge.invalid`, legacy]);
    expect((await request("POST", "/admin/api/users", headers, { email: `reserved-${suffix}@forge.local`, username: `__déléted__new-${suffix}` })).statusCode).toBe(400);
    expect((await request("DELETE", `/admin/api/users/${target}`, await tag(target))).statusCode).toBe(200);
    expect((await user(target)).status).toBe("deleted");
  });

  it("audits before/after safely, snapshots actor names, filters and pages without duplicates", async () => {
    const actor = await makeUser("actor", { role: "platform_admin", dataScope: "all" });
    const target = await makeUser("audit-target");
    const h = await cookieFor(actor);
    expect((await request("PATCH", `/admin/api/users/${target}`, await tag(target, h), { displayName: "Changed for audit" })).statusCode).toBe(200);
    await repos.updateUser(actor, { displayName: "New actor name" }, { expectedRevision: "system" });
    const res = await app.inject({ url: `/admin/api/audit?resourceId=${target}&limit=1`, headers });
    expect(res.statusCode).toBe(200);
    const item = res.json().items[0];
    expect(item).toMatchObject({ actor_id: actor, actor_name: "Life actor", outcome: "success" });
    expect(item.details_json).toMatchObject({ before: { displayName: "Life audit-target" }, after: { displayName: "Changed for audit" } });
    expect((await app.inject({ url: `/admin/api/audit/${item.id}`, headers })).json().id).toBe(item.id);
    const first = (await app.inject({ url: "/admin/api/audit?limit=1", headers })).json();
    expect(first.nextCursor).toBeTypeOf("string");
    const next = (await app.inject({ url: `/admin/api/audit?limit=1&cursor=${first.nextCursor}`, headers })).json();
    expect(next.items[0].id).not.toBe(first.items[0].id);
    expect((await app.inject({ url: "/admin/api/audit?cursor=invalid", headers })).statusCode).toBe(400);
    for (const from of ["2026-02-30T12:00:00Z", "2026-11-01T12:00:00"]) expect((await app.inject({ url: `/admin/api/audit?from=${encodeURIComponent(from)}`, headers })).statusCode).toBe(400);
    expect((await app.inject({ url: "/admin/api/audit?from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z", headers })).statusCode).toBe(400);
  });
});

it("rate limits account attempts atomically and resets expired windows", async () => {
  const key = randomBytes(32).toString("hex"), start = new Date();
  const attempts = await Promise.allSettled(Array.from({ length: 15 }, () => repos.reserveLoginAttempts([{ key, maximum: 10, windowMs: 900_000 }], start)));
  expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(10);
  for (const r of attempts.filter(r => r.status === "rejected")) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "AUTH-1002", httpStatus: 429 });
  await repos.reserveLoginAttempts([{ key, maximum: 10, windowMs: 900_000 }], new Date(start.getTime() + 900_001));
  await repos.clearLoginAttempts(key);
});

it("serializes last-admin revocation and ignores passwordless unbound administrators", async () => {
  // Isolated transaction rollback preserves the seeded administrator and all concurrent fixtures.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { lockAccounts, assertActivePlatformAdmin } = await import("../packages/store/src/account-write.js");
    await lockAccounts(conn);
    const [rows] = await conn.query("SELECT id FROM users WHERE role = 'platform_admin' FOR UPDATE");
    const adminIds = (rows as Array<{ id: string }>).map(r => r.id);
    for (const id of adminIds) await conn.execute("UPDATE users SET status = 'disabled' WHERE id = ?", [id]);
    await expect(assertActivePlatformAdmin(conn)).rejects.toMatchObject({ code: "CFG-8503" });
    await conn.execute("UPDATE users SET status = 'active', password_hash = NULL, idp_subject = NULL WHERE id = ?", [ADMIN]);
    await expect(assertActivePlatformAdmin(conn)).rejects.toMatchObject({ code: "CFG-8503" });
    await conn.execute("UPDATE users SET password_hash = 'scrypt$aa$bb' WHERE id = ?", [ADMIN]);
    await expect(assertActivePlatformAdmin(conn)).rejects.toMatchObject({ code: "CFG-8503" });
    expect(config.ALLOW_LOCAL_LOGIN).toBe(true);
  } finally { await conn.rollback(); conn.release(); }
});

it("records denied operations under the trusted actor organization with stable action and safe details", async () => {
  const actor = await makeUser("failure-org-admin", { role: "org_admin", dataScope: "org" });
  const target = await makeUser("failure-target", { dataScope: "all" });
  const h = await cookieFor(actor);
  const res = await request("POST", `/admin/api/users/${target}/password`, await tag(target, h), { password: "DoNotRecord!2026" });
  expect(res.statusCode).toBe(403);
  const page = await app.inject({ url: `/admin/api/audit?action=user.password.reset&resourceId=${target}&outcome=denied`, headers: h });
  expect(page.statusCode).toBe(200);
  expect(page.json().items).toHaveLength(1);
  const entry = page.json().items[0];
  expect(entry).toMatchObject({ actor_id: actor, org_unit_id: ROOT, outcome: "denied", action: "user.password.reset" });
  expect(JSON.stringify(entry)).not.toContain("DoNotRecord");
  expect((await app.inject({ url: `/admin/api/audit/${entry.id}`, headers: h })).statusCode).toBe(200);
});

it("refuses legacy ambiguous aliases even if the other account is disabled", async () => {
  const first = await makeUser("ambiguous-first"), second = await makeUser("ambiguous-second", {status:"disabled"});
  const row = await user(first);
  await execute("UPDATE users SET email = ? WHERE id = ?", [row.username,second]);
  expect(await repos.getUserByLogin(row.username)).toBeNull();
  await expect(loginLocal(row.username,password)).rejects.toMatchObject({code:"AUTH-1001"});
});

it("normalizes parse failures before recording the operation outcome", async () => {
  const res = await app.inject({method:"POST",url:"/auth/local/login",headers:{"content-type":"application/json","x-request-id":`parse-${suffix}`},payload:"{invalid"});
  expect(res.statusCode).toBe(400);
  const entries = await query<{details_json: {code:string;requestId:string}}>("SELECT details_json FROM audit_logs WHERE action = 'auth.login.local' AND outcome = 'failure' ORDER BY created_at DESC,id DESC LIMIT 1");
  expect(entries[0]!.details_json.code).toBe(res.json().error.code);
});

it("rejects an account write queued before its actor sessions were revoked", {timeout:10_000}, async () => {
  const actor = await makeUser("queued-actor",{role:"platform_admin",dataScope:"all"});
  const h = await cookieFor(actor);
  const conn = await pool.getConnection();
  let pending: ReturnType<typeof request> | undefined;
  try {
    await conn.beginTransaction();
    const { lockAccounts } = await import("../packages/store/src/account-write.js");
    await lockAccounts(conn);
    pending = request("POST","/admin/api/users",h,{email:`queued-blocked-${suffix}@forge.local`});
    const response = Promise.resolve(pending);
    const deadline = Date.now()+3000;
    let waiting = false;
    while (Date.now()<deadline) {
      const rows = await query<{n:number}>("SELECT COUNT(*) n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'settings'");
      if (Number(rows[0]!.n)>0) { waiting=true;break; }
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect(waiting).toBe(true);
    await conn.execute("UPDATE users SET revision=revision+1 WHERE id=?",[actor]);
    await conn.execute("DELETE FROM auth_sessions WHERE user_id=?",[actor]);
    await conn.commit();
    expect((await response).statusCode).toBe(401);
    expect(await repos.getUserByEmail(`queued-blocked-${suffix}@forge.local`)).toBeNull();
  } finally { await conn.rollback();conn.release();if(pending) await pending; }
});
