import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Principal } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession } from "./helpers/real-session.js";

// I-SCOPE-13/14 plan A (needs a *_test DB): audit rows record the resource's department at write time and
// GET /admin/api/audit filters by the caller's dataScope (all / org subtree / self), never by the actor's department.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const id26 = (tag: string): string => `${tag}${randomBytes(16).toString("hex").toUpperCase()}`.slice(0, 26);
const P = id26("IAOP");
const C = id26("IAOC");
const S = id26("IAOS");
let app: FastifyInstance;
const agents: string[] = [];
const auditIds = { p: "", c: "", s: "", legacy: "", platform: "", actorMoved: "" };

async function cookieFor(principal: Pick<Principal, "role" | "orgUnitId" | "dataScope">): Promise<{ headers: Record<string, string>; userId: string }> {
  const session = await realSession({ name: "IT audit", ...principal });
  return { headers: { cookie: `forge_session=${sessionCookieValue(session)}` }, userId: session.principal.id };
}
async function agentIn(org: string | null, tag: string): Promise<string> {
  const id = await repos.createAgent({ key: `it-aud-${tag}-${suffix}`, name: tag, ownerOrgUnitId: org, createdBy: ADMIN_ID });
  agents.push(id);
  return id;
}
async function lastAuditId(resourceId: string, action: string): Promise<string> {
  const rows = await query<{ id: string }>("SELECT id FROM audit_logs WHERE resource_id = ? AND action = ? ORDER BY created_at DESC, id DESC LIMIT 1", [resourceId, action]);
  return rows[0]!.id;
}
async function visible(headers: Record<string, string>): Promise<Set<string>> {
  const res = await app.inject({ method: "GET", url: "/admin/api/audit?limit=500", headers });
  expect(res.statusCode).toBe(200);
  return new Set((res.json() as { items: Array<{ id: string }> }).items.map((row) => row.id));
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [P, ROOT, `it-aud-p-${suffix}`, "IT aud P", `/it-aud-p-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [C, P, `it-aud-c-${suffix}`, "IT aud C", `/it-aud-p-${suffix}/it-aud-c-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [S, ROOT, `it-aud-s-${suffix}`, "IT aud S", `/it-aud-s-${suffix}/`]);
  const [ap, ac, as, ag] = [await agentIn(P, "p"), await agentIn(C, "c"), await agentIn(S, "s"), await agentIn(null, "g")];
  // A legacy row as it exists before migration 006 (no department).
  await execute("INSERT INTO audit_logs (id, actor_type, actor_id, action, resource_type, resource_id, details_json) VALUES (?, 'user', ?, 'agent.update', 'agent', ?, '{}')", [id26("aud"), ADMIN_ID, ap]);
  auditIds.legacy = (await query<{ id: string }>("SELECT id FROM audit_logs WHERE resource_id = ? AND org_unit_id IS NULL ORDER BY id DESC LIMIT 1", [ap]))[0]!.id;
  await repos.audit({ actorType: "user", actorId: ADMIN_ID, action: "agent.create", resourceType: "agent", resourceId: ap });
  await repos.audit({ actorType: "user", actorId: ADMIN_ID, action: "agent.create", resourceType: "agent", resourceId: ac });
  await repos.audit({ actorType: "user", actorId: ADMIN_ID, action: "agent.create", resourceType: "agent", resourceId: as });
  await repos.audit({ actorType: "user", actorId: ADMIN_ID, action: "agent.create", resourceType: "agent", resourceId: ag });
  auditIds.p = await lastAuditId(ap, "agent.create");
  auditIds.c = await lastAuditId(ac, "agent.create");
  auditIds.s = await lastAuditId(as, "agent.create");
  auditIds.platform = await lastAuditId(ag, "agent.create");
});

afterAll(async () => {
  await cleanupRealSessions();
  for (const id of agents) await execute("DELETE FROM agents WHERE id = ?", [id]);
  await execute("DELETE FROM org_units WHERE id IN (?, ?, ?)", [C, P, S]);
  await app?.close();
});

describe("migration 006", () => {
  it("audit_logs.org_unit_id is nullable and idx_audit_org exists", async () => {
    const cols = await query<{ IS_NULLABLE: string }>("SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'org_unit_id'");
    expect(cols[0]?.IS_NULLABLE).toBe("YES");
    const idx = await query("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND INDEX_NAME = 'idx_audit_org'");
    expect(idx.length).toBeGreaterThan(0);
  });
});

describe("write: the resource's department, not the actor's", () => {
  it("agent rows carry the agent owner department; global agent -> NULL", async () => {
    const rows = await query<{ id: string; org_unit_id: string | null }>("SELECT id, org_unit_id FROM audit_logs WHERE id IN (?, ?, ?, ?)", [auditIds.p, auditIds.c, auditIds.s, auditIds.platform]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.org_unit_id]));
    expect(byId[auditIds.p]).toBe(P);
    expect(byId[auditIds.c]).toBe(C);
    expect(byId[auditIds.s]).toBe(S);
    expect(byId[auditIds.platform]).toBeNull();
  });
  it("an actor from department P acting on S's resource is recorded in S; moving the actor later changes nothing", async () => {
    const actor = await cookieFor({ role: "org_admin", orgUnitId: P, dataScope: "org" });
    const as = agents[2]!;
    await repos.audit({ actorType: "user", actorId: actor.userId, action: "agent.update", resourceType: "agent", resourceId: as });
    auditIds.actorMoved = await lastAuditId(as, "agent.update");
    await repos.updateUser(actor.userId, { orgUnitId: S });
    const row = await query<{ org_unit_id: string | null }>("SELECT org_unit_id FROM audit_logs WHERE id = ?", [auditIds.actorMoved]);
    expect(row[0]?.org_unit_id).toBe(S);
  });
});

describe("read: GET /admin/api/audit by dataScope", () => {
  it("org_admin of P (org subtree): P + child C; not sibling S, not NULL rows (legacy / platform)", async () => {
    const { headers } = await cookieFor({ role: "org_admin", orgUnitId: P, dataScope: "org" });
    const ids = await visible(headers);
    expect(ids.has(auditIds.p)).toBe(true);
    expect(ids.has(auditIds.c)).toBe(true);
    expect(ids.has(auditIds.s)).toBe(false);
    expect(ids.has(auditIds.legacy)).toBe(false);
    expect(ids.has(auditIds.platform)).toBe(false);
    expect(ids.has(auditIds.actorMoved)).toBe(false);
  });
  it("org_admin of child C cannot see the parent P", async () => {
    const { headers } = await cookieFor({ role: "org_admin", orgUnitId: C, dataScope: "org" });
    const ids = await visible(headers);
    expect(ids.has(auditIds.c)).toBe(true);
    expect(ids.has(auditIds.p)).toBe(false);
  });
  it("dataScope all sees everything incl. NULL rows, whatever the role (platform_admin, auditor, org_admin granted all)", async () => {
    for (const role of ["platform_admin", "auditor", "org_admin"] as const) {
      const { headers } = await cookieFor({ role, orgUnitId: S, dataScope: "all" });
      const ids = await visible(headers);
      for (const id of [auditIds.p, auditIds.c, auditIds.s, auditIds.legacy, auditIds.platform]) expect(ids.has(id), `${role} ${id}`).toBe(true);
    }
  });
  it("dataScope self -> only rows the caller produced", async () => {
    const me = await cookieFor({ role: "org_admin", orgUnitId: P, dataScope: "self" });
    await repos.audit({ actorType: "user", actorId: me.userId, action: "agent.update", resourceType: "agent", resourceId: agents[2]! });
    const mine = await lastAuditId(agents[2]!, "agent.update");
    const ids = await visible(me.headers);
    expect(ids.has(mine)).toBe(true);
    expect(ids.has(auditIds.p)).toBe(false);
  });
  it("org_admin without a department -> empty list, not an error", async () => {
    const { headers } = await cookieFor({ role: "org_admin", orgUnitId: null, dataScope: "org" });
    expect((await visible(headers)).size).toBe(0);
  });
});
