import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Principal } from "@forge/core";
import { createSession, destroySession, sessionCookieValue, type Session } from "@forge/identity";
import { execute, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// Schedules and service accounts use the same department scope as runs (canAccessRun): dataScope all -> everything,
// otherwise the caller's department plus all of its sub-departments. Approval decide: an approval whose run the caller
// cannot see answers exactly like a nonexistent approval, without any Run wording.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const id26 = (tag: string): string => `${tag}${randomBytes(16).toString("hex").toUpperCase()}`.slice(0, 26);
const PARENT = id26("ITSP");
const CHILD = id26("ITSC");
const SIBLING = id26("ITSS");
const sessions: Session[] = [];
const accounts: string[] = [];
const schedules: string[] = [];
let app: FastifyInstance;
let agentId = "";
let versionId = "";

function headersFor(principal: Omit<Principal, "type" | "id" | "name">): Record<string, string> {
  const session = createSession({ type: "user", id: `it-sub-${sessions.length}`, name: "IT sub", ...principal });
  sessions.push(session);
  return { cookie: `forge_session=${sessionCookieValue(session)}`, "x-csrf-token": session.csrfToken };
}
async function account(orgUnitId: string, tag: string): Promise<string> {
  const id = await repos.createServiceAccount({ key: `it-sub-${tag}-${suffix}`, name: tag, orgUnitId, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
  accounts.push(id);
  return id;
}
async function schedule(orgUnitId: string, tag: string): Promise<string> {
  const acc = await account(orgUnitId, `sa-${tag}`);
  const id = await repos.createSchedule({ key: `it-sub-sch-${tag}-${suffix}`, name: tag, agentId, orgUnitId, subjectType: "service", subjectId: acc, serviceAccountId: acc, cron: "0 9 * * *", timezone: "Asia/Shanghai", input: { text: "x" }, status: "disabled", createdBy: ADMIN_ID });
  schedules.push(id);
  return id;
}
const ids = (res: LightMyRequestResponse) => (res.json() as { items: Array<{ id: string }> }).items.map((item) => item.id);
const errorShape = (res: LightMyRequestResponse) => {
  const { requestId: _ignored, ...error } = (res.json() as { error: Record<string, unknown> }).error;
  return { status: res.statusCode, error };
};

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [PARENT, ROOT, `it-sub-p-${suffix}`, "IT parent", `/it-sub-p-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [CHILD, PARENT, `it-sub-c-${suffix}`, "IT child", `/it-sub-p-${suffix}/it-sub-c-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [SIBLING, ROOT, `it-sub-s-${suffix}`, "IT sibling", `/it-sub-s-${suffix}/`]);
  agentId = await repos.createAgent({ key: `it-sub-agent-${suffix}`, name: "IT sub agent", ownerOrgUnitId: PARENT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(agentId, versionId);
});

afterAll(async () => {
  for (const session of sessions) destroySession(session.token);
  for (const id of schedules) {
    await execute("DELETE FROM audit_logs WHERE resource_type = 'schedule' AND resource_id = ?", [id]);
    await execute("DELETE FROM schedules WHERE id = ?", [id]);
  }
  await execute("DELETE FROM schedules WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  for (const id of accounts) await execute("DELETE FROM service_accounts WHERE id = ?", [id]);
  await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  await execute("DELETE FROM org_units WHERE id IN (?, ?, ?)", [CHILD, PARENT, SIBLING]);
  await app?.close();
});

describe("schedules: department + sub-departments", () => {
  it("parent-department org_admin sees and edits child schedules; sibling stays 404; child cannot see parent", async () => {
    const childSch = await schedule(CHILD, "c");
    const parentSch = await schedule(PARENT, "p");
    const siblingSch = await schedule(SIBLING, "s");
    const parent = headersFor({ role: "org_admin", orgUnitId: PARENT, dataScope: "org" });
    const child = headersFor({ role: "org_admin", orgUnitId: CHILD, dataScope: "org" });

    const list = ids(await app.inject({ method: "GET", url: "/admin/api/schedules", headers: parent }));
    expect(list).toEqual(expect.arrayContaining([childSch, parentSch]));
    expect(list).not.toContain(siblingSch);
    expect((await app.inject({ method: "GET", url: `/admin/api/schedules/${childSch}`, headers: parent })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/admin/api/schedules/${childSch}`, headers: parent, payload: { name: "renamed" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/admin/api/schedules/${siblingSch}`, headers: parent })).statusCode).toBe(404);

    expect(ids(await app.inject({ method: "GET", url: "/admin/api/schedules", headers: child }))).not.toContain(parentSch);
    expect((await app.inject({ method: "GET", url: `/admin/api/schedules/${parentSch}`, headers: child })).statusCode).toBe(404);
  });

  it("binding a service account from a child department is allowed; from a sibling -> 404", async () => {
    const parent = headersFor({ role: "org_admin", orgUnitId: PARENT, dataScope: "org" });
    const childAcc = await account(CHILD, "bind-c");
    const siblingAcc = await account(SIBLING, "bind-s");
    const ok = await app.inject({ method: "POST", url: "/admin/api/schedules", headers: parent, payload: { key: `it-sub-new-${suffix}`, name: "n", agentId, cron: "0 9 * * *", timezone: "Asia/Shanghai", serviceAccountId: childAcc } });
    expect(ok.statusCode).toBe(200);
    schedules.push((ok.json() as { id: string }).id);
    const hidden = await app.inject({ method: "POST", url: "/admin/api/schedules", headers: parent, payload: { key: `it-sub-new2-${suffix}`, name: "n", agentId, cron: "0 9 * * *", timezone: "Asia/Shanghai", serviceAccountId: siblingAcc } });
    expect(hidden.statusCode).toBe(404);
    expect((hidden.json() as { error: { message: string } }).error.message).toBe("服务账号不存在");
  });
});

describe("service accounts: department + sub-departments", () => {
  // Only platform_admin has service_account.manage today; an org-scoped session isolates the data-scope rule.
  it("org-scoped caller sees child accounts, not sibling ones; child cannot see parent", async () => {
    const childAcc = await account(CHILD, "list-c");
    const parentAcc = await account(PARENT, "list-p");
    const siblingAcc = await account(SIBLING, "list-s");
    const parent = headersFor({ role: "platform_admin", orgUnitId: PARENT, dataScope: "org" });
    const child = headersFor({ role: "platform_admin", orgUnitId: CHILD, dataScope: "org" });
    const list = ids(await app.inject({ method: "GET", url: "/admin/api/service-accounts", headers: parent }));
    expect(list).toEqual(expect.arrayContaining([childAcc, parentAcc]));
    expect(list).not.toContain(siblingAcc);
    expect((await app.inject({ method: "GET", url: `/admin/api/service-accounts/${childAcc}`, headers: parent })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/admin/api/service-accounts/${childAcc}`, headers: parent, payload: { name: "x" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/admin/api/service-accounts/${siblingAcc}`, headers: parent })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/admin/api/service-accounts/${parentAcc}`, headers: child })).statusCode).toBe(404);
  });
});

describe("approval decide across departments", () => {
  it("invisible approval -> identical response to a nonexistent approval, no Run wording, nothing decided", async () => {
    const threadId = await repos.createThread({ agentId, orgUnitId: SIBLING, subjectType: "user", subjectId: ADMIN_ID });
    const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: SIBLING, subjectType: "user", subjectId: ADMIN_ID, input: { text: "x" }, status: "waiting_approval" });
    const toolCallId = await repos.addToolCall({ runId, toolKey: "mail.send", args: { a: 1 }, risk: "high", status: "pending" });
    const approvalId = await repos.addApproval({ runId, toolCallId, risk: "high", timeoutSeconds: 3600 });
    const operator = headersFor({ role: "operator", orgUnitId: PARENT, dataScope: "org" });
    const hidden = await app.inject({ method: "POST", url: `/admin/api/approvals/${approvalId}/decide`, headers: operator, payload: { decision: "approved" } });
    const missing = await app.inject({ method: "POST", url: `/admin/api/approvals/${id26("APRNONE")}/decide`, headers: operator, payload: { decision: "approved" } });
    expect(hidden.statusCode).toBe(404);
    expect(errorShape(hidden)).toEqual(errorShape(missing));
    expect((errorShape(hidden).error as { message: string }).message).toBe("审批不存在");
    // The error code stays the shared not-found code (RUN-7001, same as for a nonexistent approval); no run id or Run wording.
    expect(hidden.body).not.toContain(runId);
    expect(hidden.body).not.toContain("Run");
    expect((await repos.getApproval(approvalId))!.status).toBe("pending");
  });
});
