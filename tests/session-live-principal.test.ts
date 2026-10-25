import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createSession, destroySession, loadActivePrincipal, sessionCookieValue, toPrincipal, type Session } from "@forge/identity";
import { execute, pool, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// S-38: a session only remembers the user id; role, department and data scope are re-read on every request
// (loadActivePrincipal, shared with the connector). Disabled/deleted users and users in a disabled department chain
// get 401 AUTH-1001 and the session is dropped.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const id26 = (tag: string): string => `${tag}${randomBytes(16).toString("hex").toUpperCase()}`.slice(0, 26);
const ORG_P = id26("ITLP");
const ORG_Q = id26("ITLQ");
const ORG_CHILD = id26("ITLC");
const users: string[] = [];
const sessions: Session[] = [];
let app: FastifyInstance;
let memberP = "";
let memberQ = "";

async function makeUser(tag: string, orgUnitId: string | null, role = "org_admin", dataScope = "org"): Promise<string> {
  const id = await repos.createUser({ email: `it-lp-${tag}-${suffix}@forge.local`, username: `it-lp-${tag}-${suffix}`, displayName: tag, role, dataScope, orgUnitId });
  users.push(id);
  return id;
}
async function login(userId: string): Promise<{ headers: Record<string, string>; session: Session }> {
  const session = await createSession(toPrincipal((await repos.getUserById(userId))!));
  sessions.push(session);
  return { session, headers: { cookie: `forge_session=${sessionCookieValue(session)}`, "x-csrf-token": session.csrfToken } };
}
const listUsers = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/admin/api/users", headers });
const ids = (res: LightMyRequestResponse) => (res.json() as { items: Array<{ id: string }> }).items.map((item) => item.id);
const code = (res: LightMyRequestResponse) => (res.json() as { error: { code: string } }).error.code;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const org = (id: string, parent: string, path: string) =>
    execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [id, parent, `it-lp-${id.slice(0, 5)}-${suffix}`, "IT lp", path]);
  await org(ORG_P, ROOT, `/it-lp-p-${suffix}/`);
  await org(ORG_Q, ROOT, `/it-lp-q-${suffix}/`);
  await org(ORG_CHILD, ORG_Q, `/it-lp-q-${suffix}/it-lp-c-${suffix}/`);
  memberP = await makeUser("mp", ORG_P, "user", "self");
  memberQ = await makeUser("mq", ORG_Q, "user", "self");
});

afterAll(async () => {
  for (const session of sessions) await destroySession(session.token);
  for (const id of users) {
    await execute("DELETE FROM audit_logs WHERE actor_id = ?", [id]);
    await execute("DELETE FROM users WHERE id = ?", [id]);
  }
  await execute("DELETE FROM org_units WHERE id IN (?, ?, ?)", [ORG_CHILD, ORG_P, ORG_Q]);
  await app?.close();
});

describe("loadActivePrincipal", () => {
  it("reads the current row; null for missing, disabled, deleted, missing or disabled department chain", async () => {
    const id = await makeUser("lap", ORG_CHILD, "builder", "org");
    expect(await loadActivePrincipal(id)).toEqual({ type: "user", id, name: "lap", role: "builder", orgUnitId: ORG_CHILD, dataScope: "org" });
    expect(await loadActivePrincipal(id26("NOUSER"))).toBeNull();
    expect(await loadActivePrincipal("")).toBeNull();
    await repos.updateUser(id, { status: "disabled" });
    expect(await loadActivePrincipal(id)).toBeNull();
    await repos.updateUser(id, { status: "deleted" });
    expect(await loadActivePrincipal(id)).toBeNull();
    await repos.updateUser(id, { status: "active" });
    await execute("UPDATE org_units SET status = 'disabled' WHERE id = ?", [ORG_Q]);
    expect(await loadActivePrincipal(id)).toBeNull();
    await execute("UPDATE org_units SET status = 'active' WHERE id = ?", [ORG_Q]);
    await repos.updateUser(id, { orgUnitId: id26("NOORG") });
    expect(await loadActivePrincipal(id)).toBeNull();
    await repos.updateUser(id, { orgUnitId: null });
    expect((await loadActivePrincipal(id))?.orgUnitId).toBeNull();
  });

  it("one query per lookup", async () => {
    const id = await makeUser("q1", ORG_CHILD, "builder", "org");
    const spy = vi.spyOn(pool, "query");
    await loadActivePrincipal(id);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("session principal is re-read on every request", () => {
  it("disabled after login -> next request 401 AUTH-1001 and the session is gone", async () => {
    const id = await makeUser("dis", ORG_P);
    const { headers, session } = await login(id);
    expect((await listUsers(headers)).statusCode).toBe(200);
    await repos.updateUser(id, { status: "disabled" });
    const res = await listUsers(headers);
    expect(res.statusCode).toBe(401);
    expect(code(res)).toBe("AUTH-1001");
    await repos.updateUser(id, { status: "active" });
    expect((await listUsers(headers)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/auth/session", headers })).statusCode).toBe(401);
    expect(session.token).toBeTruthy();
  });

  it("deleted after login -> 401", async () => {
    const id = await makeUser("del", ORG_P);
    const { headers } = await login(id);
    await execute("DELETE FROM users WHERE id = ?", [id]);
    expect((await listUsers(headers)).statusCode).toBe(401);
  });

  it("demoted after login -> judged with the new role (403), /auth/session shows the new role", async () => {
    const id = await makeUser("dem", ORG_P);
    const { headers } = await login(id);
    expect((await listUsers(headers)).statusCode).toBe(200);
    await repos.updateUser(id, { role: "user", dataScope: "self" });
    const res = await listUsers(headers);
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("POL-2001");
    const me = (await app.inject({ method: "GET", url: "/auth/session", headers })).json() as { user: { role: string; dataScope: string } };
    expect(me.user).toMatchObject({ role: "user", dataScope: "self" });
  });

  it("moved to another department after login -> scope follows the new department", async () => {
    const id = await makeUser("mov", ORG_P);
    const { headers } = await login(id);
    let seen = ids(await listUsers(headers));
    expect(seen).toContain(memberP);
    expect(seen).not.toContain(memberQ);
    await repos.updateUser(id, { orgUnitId: ORG_Q });
    seen = ids(await listUsers(headers));
    expect(seen).toContain(memberQ);
    expect(seen).not.toContain(memberP);
  });

  it("department (or a parent department) disabled after login -> 401", async () => {
    const id = await makeUser("orgoff", ORG_CHILD);
    const { headers } = await login(id);
    expect((await listUsers(headers)).statusCode).toBe(200);
    await execute("UPDATE org_units SET status = 'disabled' WHERE id = ?", [ORG_Q]);
    try {
      expect((await listUsers(headers)).statusCode).toBe(401);
    } finally {
      await execute("UPDATE org_units SET status = 'active' WHERE id = ?", [ORG_Q]);
    }
  });

  it("authentication costs two queries per request: session row + principal (GET /auth/session; mutating request incl. CSRF check)", async () => {
    const id = await makeUser("cnt", ORG_P, "user", "self");
    const { headers } = await login(id);
    const spy = vi.spyOn(pool, "query");
    const res = await app.inject({ method: "GET", url: "/auth/session", headers });
    expect(res.statusCode).toBe(200);
    // Session store (007): one auth_sessions lookup + one principal lookup.
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    // The CSRF hook and admin() share the request's single auth_sessions lookup; then the principal, then 403 (role
    // user lacks user.manage).
    const post = await app.inject({ method: "POST", url: "/admin/api/users", headers, payload: { email: `x-${suffix}@forge.local` } });
    expect(post.statusCode).toBe(403);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
