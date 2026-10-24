import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Principal } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { AUDIT_ORG_SOURCES, AUDIT_PLATFORM_RESOURCES, execute, query, repos, userUpdateAuditEntries } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// Acceptance 7.2 / 7.3 / 7.4 (needs a *_test DB): W-01..W-05, T-A..T-E, S-04 / S-05 negatives.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const id26 = (tag: string): string => `${tag}${randomBytes(16).toString("hex").toUpperCase()}`.slice(0, 26);
const A = id26("IAWA");
const B = id26("IAWB");
const tag = `aw-${suffix}`;
let app: FastifyInstance;
const ids: Record<string, string> = {};

async function orgOf(resourceType: string, resourceId: string, action = `it.${tag}`): Promise<string | null> {
  await repos.audit({ actorType: "user", actorId: ADMIN_ID, action, resourceType, resourceId });
  const rows = await query<{ org_unit_id: string | null }>("SELECT org_unit_id FROM audit_logs WHERE action = ? AND resource_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", [action, resourceId]);
  expect(rows).toHaveLength(1);
  return rows[0]!.org_unit_id;
}
async function headersFor(principal: Pick<Principal, "role" | "orgUnitId" | "dataScope">) {
  const session = await realSession({ name: "IT audit write", ...principal });
  return { headers: sessionHeaders(session, sessionCookieValue(session)), userId: session.principal.id };
}
async function visibleActions(headers: Record<string, string>): Promise<Array<{ id: string; action: string; resource_id: string | null; actor_type: string; actor_id: string | null }>> {
  const res = await app.inject({ method: "GET", url: "/admin/api/audit?limit=500", headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as { items: Array<{ id: string; action: string; resource_id: string | null; actor_type: string; actor_id: string | null }> }).items;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [A, ROOT, `it-aw-a-${suffix}`, "IT aw A", `/it-aw-a-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [B, ROOT, `it-aw-b-${suffix}`, "IT aw B", `/it-aw-b-${suffix}/`]);
  ids.agent = await repos.createAgent({ key: `it-aw-${suffix}`, name: "IT aw", ownerOrgUnitId: A, createdBy: ADMIN_ID });
  ids.globalAgent = await repos.createAgent({ key: `it-aw-g-${suffix}`, name: "IT aw g", ownerOrgUnitId: null, createdBy: ADMIN_ID });
  ids.agent_version = await repos.createAgentVersion({ agentId: ids.agent, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  ids.thread = await repos.createThread({ agentId: ids.agent, orgUnitId: A, subjectType: "user", subjectId: ADMIN_ID });
  ids.run = await repos.createRun({ threadId: ids.thread, agentId: ids.agent, agentVersionId: ids.agent_version, orgUnitId: A, subjectType: "user", subjectId: ADMIN_ID, input: { text: "x" }, status: "waiting_approval" });
  ids.toolCall = await repos.addToolCall({ runId: ids.run, toolKey: "echo", args: {}, risk: "high", status: "pending" });
  ids.approval = await repos.addApproval({ runId: ids.run, toolCallId: ids.toolCall, risk: "high", timeoutSeconds: 3600 });
  ids.service_account = await repos.createServiceAccount({ key: `it-aw-svc-${suffix}`, name: "IT aw svc", orgUnitId: A, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
  ids.schedule = await repos.createSchedule({
    key: `it-aw-${suffix}`, name: "IT aw", agentId: ids.agent, orgUnitId: A, subjectType: "service", subjectId: ids.service_account, serviceAccountId: ids.service_account,
    cron: "0 9 * * *", timezone: "Asia/Shanghai", input: { text: "x" }, status: "disabled", nextRunAt: null, createdBy: ADMIN_ID,
  });
  ids.user = await repos.createUser({ email: `it-aw-${suffix}@forge.local`, username: `it-aw-${suffix}`, displayName: "IT aw", role: "user", dataScope: "self", orgUnitId: A });
  ids.api_app = await repos.createApiApp({ key: `it-aw-${suffix}`, name: "IT aw", ownerOrgUnitId: A, scopes: [], createdBy: ADMIN_ID });
  ids.orphanApp = await repos.createApiApp({ key: `it-aw-o-${suffix}`, name: "IT aw o", ownerOrgUnitId: null, scopes: [], createdBy: ADMIN_ID });
  ids.api_key = await repos.createApiKey({ appId: ids.api_app, name: "k", prefix: `p${suffix}`.slice(0, 12), keyHash: `h-${suffix}`, scopes: [] });
  ids.webhook_delivery = (await repos.enqueueWebhook({ appId: ids.api_app, eventId: `ev-${suffix}`, eventType: "run.completed", payload: {} }))!;
  ids.orphanDelivery = (await repos.enqueueWebhook({ appId: ids.orphanApp, eventId: `ev-o-${suffix}`, eventType: "run.completed", payload: {} }))!;
});

afterAll(async () => {
  await execute("DELETE FROM webhook_deliveries WHERE id IN (?, ?)", [ids.webhook_delivery, ids.orphanDelivery]);
  await execute("DELETE FROM api_keys WHERE id = ?", [ids.api_key]);
  await execute("DELETE FROM api_apps WHERE id IN (?, ?)", [ids.api_app, ids.orphanApp]);
  await execute("DELETE FROM schedules WHERE id = ?", [ids.schedule]);
  await execute("DELETE FROM service_accounts WHERE id = ?", [ids.service_account]);
  await execute("DELETE FROM approvals WHERE id = ?", [ids.approval]);
  await execute("DELETE FROM tool_calls WHERE id = ?", [ids.toolCall]);
  await execute("DELETE FROM run_events WHERE run_id = ?", [ids.run]);
  await execute("DELETE FROM runs WHERE id = ?", [ids.run]);
  await execute("DELETE FROM threads WHERE id = ?", [ids.thread]);
  await execute("DELETE FROM agent_versions WHERE id = ?", [ids.agent_version]);
  await execute("DELETE FROM agents WHERE id IN (?, ?)", [ids.agent, ids.globalAgent]);
  await execute("DELETE FROM users WHERE id = ?", [ids.user]);
  await execute("DELETE FROM audit_logs WHERE action LIKE ?", [`it.${tag}%`]);
  await cleanupRealSessions();
  await execute("DELETE FROM org_units WHERE id IN (?, ?)", [A, B]);
  await app?.close();
});

describe("W-01 / W-03 / W-04: the audit row carries the resource's department", () => {
  for (const type of ["agent", "agent_version", "run", "approval", "schedule", "service_account", "user", "api_app", "api_key", "webhook_delivery"]) {
    it(`${type} -> department A`, async () => {
      expect(AUDIT_ORG_SOURCES[type]).toBeTruthy();
      expect(await orgOf(type, ids[type]!)).toBe(A);
    });
  }
  it("platform resources and a global agent -> NULL", async () => {
    for (const type of AUDIT_PLATFORM_RESOURCES) expect(await orgOf(type, id26("PLT"))).toBeNull();
    expect(await orgOf("agent", ids.globalAgent!)).toBeNull();
  });
  it("W-04: webhook_delivery of an app without a department -> NULL", async () => {
    expect(await orgOf("webhook_delivery", ids.orphanDelivery!)).toBeNull();
  });
  it("W-02: the actor's department is never used (a B-department actor on an A resource -> A)", async () => {
    const actor = await headersFor({ role: "platform_admin", orgUnitId: B, dataScope: "all" });
    await repos.audit({ actorType: "user", actorId: actor.userId, action: `it.${tag}.w02`, resourceType: "agent", resourceId: ids.agent });
    const rows = await query<{ org_unit_id: string | null }>("SELECT org_unit_id FROM audit_logs WHERE action = ?", [`it.${tag}.w02`]);
    expect(rows.map((r) => r.org_unit_id)).toEqual([A]);
  });
  it("W-05: a failing department lookup writes NULL and keeps the row", async () => {
    const original = AUDIT_ORG_SOURCES.agent!;
    AUDIT_ORG_SOURCES.agent = "SELECT org_unit_id FROM it_no_such_table WHERE id = ?";
    try {
      expect(await orgOf("agent", ids.agent!, `it.${tag}.w05`)).toBeNull();
    } finally {
      AUDIT_ORG_SOURCES.agent = original;
    }
  });
});

describe("T-A..T-E: department transfer (ruling 2)", () => {
  it("T-A/T-B/T-C: update in the new department, transfer_out in the old one; each side sees only its row", async () => {
    for (const entry of userUpdateAuditEntries(A, B, { role: "user" })) {
      await repos.audit({ actorType: "user", actorId: ADMIN_ID, action: entry.action === "user.update" ? `it.${tag}.user.update` : `it.${tag}.user.org_transfer_out`, resourceType: "user", resourceId: ids.user, details: entry.details, orgUnitId: entry.orgUnitId });
    }
    const rows = await query<{ action: string; org_unit_id: string; details_json: unknown }>("SELECT action, org_unit_id, details_json FROM audit_logs WHERE action IN (?, ?) ORDER BY action", [`it.${tag}.user.org_transfer_out`, `it.${tag}.user.update`]);
    expect(rows.map((r) => [r.action.replace(`it.${tag}.`, ""), r.org_unit_id])).toEqual([["user.org_transfer_out", A], ["user.update", B]]);
    const details = typeof rows[0]!.details_json === "string" ? JSON.parse(rows[0]!.details_json as string) : rows[0]!.details_json;
    expect(JSON.stringify(details)).toContain(A);
    expect(JSON.stringify(details)).toContain(B);
    const oaA = await headersFor({ role: "org_admin", orgUnitId: A, dataScope: "org" });
    const oaB = await headersFor({ role: "org_admin", orgUnitId: B, dataScope: "org" });
    const seenA = (await visibleActions(oaA.headers)).map((r) => r.action);
    const seenB = (await visibleActions(oaB.headers)).map((r) => r.action);
    expect(seenA).toContain(`it.${tag}.user.org_transfer_out`);
    expect(seenA).not.toContain(`it.${tag}.user.update`);
    expect(seenB).toContain(`it.${tag}.user.update`);
    expect(seenB).not.toContain(`it.${tag}.user.org_transfer_out`);
  });
  it("T-D: PATCH that changes only the role (or passes the same orgUnitId) writes one user.update and no transfer_out", async () => {
    const pa = await headersFor({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
    const before = await query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE resource_id = ? AND action = 'user.org_transfer_out'", [ids.user]);
    for (const payload of [{ displayName: "IT aw 2" }, { displayName: "IT aw 3", orgUnitId: A }]) {
      const res = await app.inject({ method: "PATCH", url: `/admin/api/users/${ids.user}`, headers: pa.headers, payload });
      expect(res.statusCode).toBe(200);
    }
    const updates = await query<{ org_unit_id: string }>("SELECT org_unit_id FROM audit_logs WHERE resource_id = ? AND action = 'user.update'", [ids.user]);
    expect(updates.map((r) => r.org_unit_id)).toEqual([A, A]);
    const after = await query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE resource_id = ? AND action = 'user.org_transfer_out'", [ids.user]);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    await execute("DELETE FROM audit_logs WHERE resource_id = ? AND action = 'user.update'", [ids.user]);
  });
});

describe("S-04 / S-05: self scope negatives", () => {
  it("self sees its own user actions, not an app or service account that happens to share the id", async () => {
    const me = await headersFor({ role: "auditor", orgUnitId: A, dataScope: "self" });
    await repos.audit({ actorType: "user", actorId: me.userId, action: `it.${tag}.self.mine`, resourceType: "agent", resourceId: ids.globalAgent });
    await repos.audit({ actorType: "app", actorId: me.userId, action: `it.${tag}.self.app`, resourceType: "run", resourceId: ids.run });
    await repos.audit({ actorType: "service_account", actorId: me.userId, action: `it.${tag}.self.sa`, resourceType: "run", resourceId: ids.run });
    const seen = (await visibleActions(me.headers)).map((r) => r.action);
    expect(seen).toContain(`it.${tag}.self.mine`);
    expect(seen).not.toContain(`it.${tag}.self.app`);
    expect(seen).not.toContain(`it.${tag}.self.sa`);
    expect(seen.filter((a) => a.startsWith(`it.${tag}`) && !a.startsWith(`it.${tag}.self.mine`))).toEqual([]);
  });
});
