import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Principal } from "@forge/core";
import { createSession, destroySession, sessionCookieValue, type Session } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// org_admin user management (permissions.md / AGENTS.md 5.3): a non-platform_admin manages only users inside its
// visible org subtree (others -> same 404 as nonexistent), cannot grant a wider dataScope or a higher role (403 POL-2001),
// cannot touch a platform_admin, and cannot move users to another department. platform_admin is unchanged.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const id26 = (tag: string): string => `${tag}${randomBytes(16).toString("hex").toUpperCase()}`.slice(0, 26);
const ORG_A = id26("ITUA");
const ORG_A_CHILD = id26("ITUC");
const ORG_B = id26("ITUB");
const createdUsers: string[] = [];
const sessions: Session[] = [];
let app: FastifyInstance;
let orgAdminId = "";
let userA = "";
let userAChild = "";
let userB = "";
let platformAdminA = "";
let peerOrgAdminA = "";
let orgAdminHeaders: Record<string, string> = {};
let platformHeaders: Record<string, string> = {};

async function makeUser(tag: string, orgUnitId: string, role = "user", dataScope = "self"): Promise<string> {
  const id = await repos.createUser({ email: `it-ua-${tag}-${suffix}@forge.local`, username: `it-ua-${tag}-${suffix}`, displayName: `IT ${tag}`, role, dataScope, orgUnitId });
  createdUsers.push(id);
  return id;
}

async function headersFor(principal: Principal): Promise<Record<string, string>> {
  const session = await createSession(principal);
  sessions.push(session);
  return { cookie: `forge_session=${sessionCookieValue(session)}`, "x-csrf-token": session.csrfToken };
}

const row = async (id: string) => (await repos.getUserById(id))!;
const patch = async (id: string, payload: Record<string, unknown>, headers = orgAdminHeaders) =>
  app.inject({ method: "PATCH", url: `/admin/api/users/${id}`, headers: await configurationHeaders(`/admin/api/users/${id}`, headers), payload });
const create = async (payload: Record<string, unknown>, headers = orgAdminHeaders) => {
  const res = await app.inject({ method: "POST", url: "/admin/api/users", headers, payload });
  if (res.statusCode === 200) createdUsers.push((res.json() as { id: string }).id);
  return res;
};
const errorOf = (res: { json: () => unknown }) => (res.json() as { error: { code: string; message: string; details?: { field?: string } } }).error;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [ORG_A, ROOT, `it-ua-a-${suffix}`, "IT ua A", `/it-ua-a-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [ORG_A_CHILD, ORG_A, `it-ua-ac-${suffix}`, "IT ua A child", `/it-ua-a-${suffix}/it-ua-ac-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [ORG_B, ROOT, `it-ua-b-${suffix}`, "IT ua B", `/it-ua-b-${suffix}/`]);
  orgAdminId = await makeUser("oa", ORG_A, "org_admin", "org");
  userA = await makeUser("a", ORG_A);
  userAChild = await makeUser("ac", ORG_A_CHILD);
  userB = await makeUser("b", ORG_B);
  platformAdminA = await makeUser("pa", ORG_A, "platform_admin", "all");
  peerOrgAdminA = await makeUser("oa2", ORG_A, "org_admin", "org");
  orgAdminHeaders = await headersFor({ type: "user", id: orgAdminId, name: "IT OrgAdmin A", role: "org_admin", orgUnitId: ORG_A, dataScope: "org" });
  platformHeaders = await headersFor({ type: "user", id: ADMIN_ID, name: "IT Platform", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
});

afterAll(async () => {
  for (const session of sessions) await destroySession(session.token);
  for (const id of createdUsers) {
    await execute("DELETE FROM audit_logs WHERE resource_type = 'user' AND resource_id = ?", [id]);
    await execute("DELETE FROM users WHERE id = ?", [id]);
  }
  if (orgAdminId) await execute("DELETE FROM audit_logs WHERE actor_id = ?", [orgAdminId]);
  await execute("DELETE FROM org_units WHERE id IN (?, ?, ?)", [ORG_A_CHILD, ORG_A, ORG_B]);
  await app?.close();
});

describe("GET /admin/api/users data scope", () => {
  it("org_admin sees only its org subtree (filtered in SQL)", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/users", headers: orgAdminHeaders });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { items: Array<{ id: string; password_hash?: unknown }> }).items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([orgAdminId, userA, userAChild, platformAdminA]));
    expect(ids).not.toContain(userB);
    expect(ids).not.toContain(ADMIN_ID);
  });

  it("platform_admin still sees every department", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/users", headers: platformHeaders });
    const ids = (res.json() as { items: Array<{ id: string }> }).items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([userA, userAChild, userB, platformAdminA]));
    expect(JSON.stringify(res.json())).not.toContain("password_hash\":\"");
  });
});

describe("PATCH /admin/api/users/:id by org_admin", () => {
  it("other department -> same 404 as nonexistent, nothing changed", async () => {
    const other = await patch(userB, { role: "builder", status: "disabled" });
    const missing = await patch(id26("NOPE"), { role: "builder", status: "disabled" });
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(errorOf(other).code).toBe(errorOf(missing).code);
    expect(errorOf(other).message).toBe(errorOf(missing).message);
    const b = await row(userB);
    expect(b.role).toBe("user");
    expect(b.status).toBe("active");
  });

  it("child department is in scope", async () => {
    const res = await patch(userAChild, { role: "operator" });
    expect(res.statusCode).toBe(200);
    expect((await row(userAChild)).role).toBe("operator");
    expect((await row(userAChild)).data_scope).toBe("org");
  });

  it("dataScope wider than the caller -> 403 POL-2001", async () => {
    const res = await patch(userA, { role: "user", dataScope: "all" });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe("POL-2001");
    expect((await row(userA)).data_scope).toBe("self");
  });

  it("role whose default scope is wider (auditor) -> default capped at the caller's scope", async () => {
    const res = await patch(userA, { role: "auditor" });
    expect(res.statusCode).toBe(200);
    const a = await row(userA);
    expect(a.role).toBe("auditor");
    expect(a.data_scope).toBe("org");
    await patch(userA, { role: "user", dataScope: "self" });
  });

  it("higher role (org_admin / platform_admin) -> 403 POL-2001 (already blocked)", async () => {
    for (const role of ["org_admin", "platform_admin"]) {
      const res = await patch(userA, { role });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe("POL-2001");
    }
    expect((await row(userA)).role).toBe("user");
  });

  it("platform_admin target cannot be demoted or disabled -> 403 POL-2001", async () => {
    for (const payload of [{ role: "user" }, { role: "user", status: "disabled" }, { status: "disabled" }, { role: "builder", dataScope: "org" }]) {
      const res = await patch(platformAdminA, payload);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe("POL-2001");
    }
    const pa = await row(platformAdminA);
    expect(pa.role).toBe("platform_admin");
    expect(pa.status).toBe("active");
    expect(pa.data_scope).toBe("all");
  });

  it("invalid dataScope -> 400", async () => {
    const res = await patch(userA, { dataScope: "everything" });
    expect(res.statusCode).toBe(400);
    expect((await row(userA)).data_scope).toBe("self");
  });

  it("department transfer stays inside the actor scope and records both departments", async () => {
    expect((await patch(userA, { orgUnitId: ORG_B })).statusCode).toBe(403);
    expect((await row(userA)).org_unit_id).toBe(ORG_A);
    expect((await patch(userA, { orgUnitId: ORG_A_CHILD })).statusCode).toBe(200);
    expect((await row(userA)).org_unit_id).toBe(ORG_A_CHILD);
    const audit = await query<{ action: string; org_unit_id: string }>("SELECT action, org_unit_id FROM audit_logs WHERE resource_id = ? AND action IN ('user.update', 'user.org_transfer_out')", [userA]);
    expect(audit).toContainEqual({ action: "user.org_transfer_out", org_unit_id: ORG_A });
    expect((await patch(userA, { orgUnitId: ORG_A })).statusCode).toBe(200);
  });

  it("status change inside scope works and is audited", async () => {
    const res = await patch(userAChild, { role: "operator", status: "disabled" });
    expect(res.statusCode).toBe(200);
    expect((await row(userAChild)).status).toBe("disabled");
    const audit = await query<{ details_json: unknown }>("SELECT details_json FROM audit_logs WHERE action = 'user.update' AND resource_id = ? ORDER BY created_at DESC LIMIT 1", [userAChild]);
    expect(JSON.stringify(audit[0]?.details_json)).toContain("disabled");
    await patch(userAChild, { role: "operator", status: "active" });
  });
});

describe("POST /admin/api/users by org_admin", () => {
  it("dataScope all -> 403 POL-2001, no user created", async () => {
    const email = `it-ua-new-all-${suffix}@forge.local`;
    const res = await create({ email, role: "user", dataScope: "all" });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe("POL-2001");
    expect(await repos.getUserByEmail(email)).toBeNull();
  });

  it("may assign a child department but cannot create in another organization", async () => {
    const email = `it-ua-new-org-${suffix}@forge.local`;
    expect((await create({ email, role: "user", orgUnitId: ORG_B })).statusCode).toBe(403);
    expect(await repos.getUserByEmail(email)).toBeNull();
    const res = await create({ email, role: "user", orgUnitId: ORG_A_CHILD });
    expect(res.statusCode).toBe(200);
    expect((await row(res.json().id)).org_unit_id).toBe(ORG_A_CHILD);
  });

  it("auditor without dataScope -> created with the caller's scope, in the caller's department", async () => {
    const res = await create({ email: `it-ua-new-aud-${suffix}@forge.local`, role: "auditor" });
    expect(res.statusCode).toBe(200);
    const created = await row((res.json() as { id: string }).id);
    expect(created.data_scope).toBe("org");
    expect(created.org_unit_id).toBe(ORG_A);
  });

  it("higher role -> 403 (already blocked)", async () => {
    const res = await create({ email: `it-ua-new-oa-${suffix}@forge.local`, role: "org_admin" });
    expect(res.statusCode).toBe(403);
  });
});

describe("platform_admin behaviour unchanged", () => {
  it("can grant dataScope all across departments and edit another platform_admin", async () => {
    expect((await patch(userB, { role: "auditor", dataScope: "all" }, platformHeaders)).statusCode).toBe(200);
    expect((await row(userB)).data_scope).toBe("all");
    expect((await patch(platformAdminA, { role: "platform_admin", status: "active" }, platformHeaders)).statusCode).toBe(200);
    expect((await row(platformAdminA)).role).toBe("platform_admin");
    expect((await patch(peerOrgAdminA, { role: "org_admin" }, platformHeaders)).statusCode).toBe(200);
  });
});
