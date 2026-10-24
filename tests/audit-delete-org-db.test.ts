import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, one, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// Delete / deactivate audit rows and the department (needs a *_test DB). On 058c1fc the only delete-class route is
// POST /admin/api/plugins/:id/uninstall (platform-level -> org_unit_id NULL by design: dataScope all sees it, an
// org_admin does not). There is no agent / user / service-account delete API; the department-bearing state-ending
// actions are deactivations (schedule.disable here), whose row records the department at write time and stays
// visible to that department's org_admin even after the resource row is later removed.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const id26 = (tag: string): string => `${tag}${randomBytes(16).toString("hex").toUpperCase()}`.slice(0, 26);
const D = id26("IADD");
const S = id26("IADS");
let app: FastifyInstance;
let pa: Record<string, string> = {};
let oaD: Record<string, string> = {};
let oaS: Record<string, string> = {};
const ids: Record<string, string> = {};

async function headersFor(role: "platform_admin" | "org_admin", orgUnitId: string, dataScope: "all" | "org"): Promise<Record<string, string>> {
  const session = await realSession({ name: `IT del ${role}`, role, orgUnitId, dataScope });
  return sessionHeaders(session, sessionCookieValue(session));
}
async function visibleActions(headers: Record<string, string>, resourceId: string): Promise<string[]> {
  const res = await app.inject({ method: "GET", url: "/admin/api/audit?limit=500", headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as { items: Array<{ resource_id?: string; resourceId?: string; action: string }> }).items
    .filter((row) => (row.resource_id ?? row.resourceId) === resourceId)
    .map((row) => row.action);
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [D, ROOT, `it-del-d-${suffix}`, "IT del D", `/it-del-d-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [S, ROOT, `it-del-s-${suffix}`, "IT del S", `/it-del-s-${suffix}/`]);
  pa = await headersFor("platform_admin", ROOT, "all");
  oaD = await headersFor("org_admin", D, "org");
  oaS = await headersFor("org_admin", S, "org");
  ids.agent = await repos.createAgent({ key: `it-del-${suffix}`, name: "IT del", ownerOrgUnitId: D, createdBy: ADMIN_ID });
  ids.account = await repos.createServiceAccount({ key: `it-del-svc-${suffix}`, name: "IT del svc", orgUnitId: D, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
  ids.schedule = await repos.createSchedule({
    key: `it-del-${suffix}`, name: "IT del", agentId: ids.agent, orgUnitId: D, subjectType: "service", subjectId: ids.account, serviceAccountId: ids.account,
    cron: "0 9 * * *", timezone: "Asia/Shanghai", input: { text: "x" }, status: "active", nextRunAt: null, createdBy: ADMIN_ID,
  });
  ids.plugin = await repos.createPlugin({ key: `it-del-plg-${suffix}`, version: "1.0.0", type: "mixed", name: "IT del plugin", manifest: {}, resources: {}, createdBy: ADMIN_ID });
});

afterAll(async () => {
  await execute("DELETE FROM audit_logs WHERE resource_id IN (?, ?)", [ids.schedule ?? "", ids.plugin ?? ""]);
  if (ids.schedule) await execute("DELETE FROM schedules WHERE id = ?", [ids.schedule]);
  if (ids.plugin) await execute("DELETE FROM plugins WHERE id = ?", [ids.plugin]);
  if (ids.account) await execute("DELETE FROM service_accounts WHERE id = ?", [ids.account]);
  if (ids.agent) await execute("DELETE FROM agents WHERE id = ?", [ids.agent]);
  await cleanupRealSessions();
  await execute("DELETE FROM users WHERE org_unit_id IN (?, ?)", [D, S]);
  await execute("DELETE FROM org_units WHERE id IN (?, ?)", [D, S]);
  await app?.close();
});

describe("delete / deactivate audit rows keep their department", () => {
  it("plugin.uninstall (the delete-class route on 058c1fc, platform-level): row NULL, visible to dataScope all only", async () => {
    const res = await app.inject({ method: "POST", url: `/admin/api/plugins/${ids.plugin}/uninstall`, headers: pa });
    expect(res.statusCode).toBe(200);
    const row = await one<{ org_unit_id: string | null; resource_id: string }>("SELECT org_unit_id, resource_id FROM audit_logs WHERE action = 'plugin.uninstall' AND resource_id = ?", [ids.plugin]);
    expect(row).toEqual({ org_unit_id: null, resource_id: ids.plugin });
    expect(await visibleActions(pa, ids.plugin!)).toContain("plugin.uninstall");
    expect(await visibleActions(oaD, ids.plugin!)).not.toContain("plugin.uninstall");
  });

  it("schedule.disable in department D: row records D at write time; D's org_admin sees it, S's does not, also after the schedule row is gone", async () => {
    const res = await app.inject({ method: "POST", url: `/admin/api/schedules/${ids.schedule}/disable`, headers: pa });
    expect(res.statusCode).toBe(200);
    const rows = await query<{ org_unit_id: string | null }>("SELECT org_unit_id FROM audit_logs WHERE action = 'schedule.disable' AND resource_id = ?", [ids.schedule]);
    expect(rows).toEqual([{ org_unit_id: D }]);
    expect(await visibleActions(oaD, ids.schedule!)).toContain("schedule.disable");
    expect(await visibleActions(oaS, ids.schedule!)).not.toContain("schedule.disable");
    await execute("DELETE FROM schedules WHERE id = ?", [ids.schedule]);
    expect(await visibleActions(oaD, ids.schedule!)).toContain("schedule.disable");
  });
});
