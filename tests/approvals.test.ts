import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "@forge/core";
import { createSession, destroySession, sessionCookieValue, type Session } from "@forge/identity";
import { execute, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
const id26 = (tag: string): string => `${tag}${randomBytes(16).toString("hex").toUpperCase()}`.slice(0, 26);
const ORG_A = id26("ITA");
const ORG_B = id26("ITB");
const SECRET = `s3cr3t-${suffix}`;
let app: FastifyInstance;
let agentId = "";
let versionId = "";
let adminHeaders: Record<string, string> = {};
const sessions: Session[] = [];
const orgAApprovals: string[] = [];
let orgBApproval = "";
let noToolApproval = "";

const headersFor = (orgUnitId: string): Record<string, string> => {
  const session = createSession({ type: "user", id: `it-apr-op-${suffix}-${sessions.length}`, name: "IT Approver", role: "operator", orgUnitId, dataScope: "org" });
  sessions.push(session);
  return { cookie: `forge_session=${sessionCookieValue(session)}`, "x-csrf-token": session.csrfToken };
};

async function pendingApproval(orgUnitId: string, args: unknown, toolKey = "mail.send"): Promise<string> {
  const threadId = await repos.createThread({ agentId, orgUnitId, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId, subjectType: "user", subjectId: ADMIN_ID, input: { text: "x" }, status: "waiting_approval" });
  const toolCallId = await repos.addToolCall({ runId, toolKey, args, risk: "high", status: "pending" });
  return repos.addApproval({ runId, toolCallId, risk: "high", timeoutSeconds: 3600 });
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/local/login", payload: { email: config.FORGE_ADMIN_EMAIL, password: config.FORGE_ADMIN_PASSWORD } });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.find((c) => c.name === "forge_session")!;
  adminHeaders = { cookie: `forge_session=${cookie.value}`, "x-csrf-token": (login.json() as { csrfToken: string }).csrfToken };
  for (const [id, tag] of [[ORG_A, "a"], [ORG_B, "b"]] as const) {
    await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [id, ROOT, `it-apr-${tag}-${suffix}`, `IT apr ${tag}`, `/it-apr-${tag}-${suffix}/`]);
  }
  agentId = await repos.createAgent({ key: `it-apr-agent-${suffix}`, name: "IT approvals agent", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  for (let i = 0; i < 3; i += 1) orgAApprovals.push(await pendingApproval(ORG_A, { to: `user${i}@example.com`, subject: "周报", api_key: SECRET, body: "z".repeat(150) }));
  // Approval whose tool call row is missing -> tool_name/args_preview null.
  noToolApproval = await pendingApproval(ORG_A, { a: 1 });
  await execute("UPDATE approvals SET tool_call_id = ? WHERE id = ?", [id26("TCLMISSING"), noToolApproval]);
  orgBApproval = await pendingApproval(ORG_B, { nested: { password: SECRET }, note: "other dept" }, "crm.update");
});

afterAll(async () => {
  for (const session of sessions) destroySession(session.token);
  if (agentId) {
    await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  }
  if (versionId) await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  if (agentId) await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  await execute("DELETE FROM org_units WHERE id IN (?, ?)", [ORG_A, ORG_B]);
  if (adminHeaders.cookie) await app.inject({ method: "POST", url: "/auth/logout", headers: adminHeaders });
  await app?.close();
});

type Item = { id: string; run_id: string; agent_id: string; agent_name: string; status: string; tool_name: string | null; args_preview: string | null };
type Page = { items: Item[]; page?: number; pageSize?: number; total?: number };
const list = async (headers: Record<string, string>, qs = ""): Promise<{ status: number; body: Page; raw: string }> => {
  const res = await app.inject({ method: "GET", url: `/admin/api/approvals${qs}`, headers });
  return { status: res.statusCode, body: res.json() as Page, raw: res.body };
};

describe("GET /admin/api/approvals", () => {
  it("without page params returns only { items } (existing callers unchanged)", async () => {
    const res = await list(headersFor(ORG_A));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["items"]);
    expect(res.body.items.map((i) => i.id).sort()).toEqual([...orgAApprovals, noToolApproval].sort());
  });

  it("paginates with page/pageSize and total counts only what the caller can see", async () => {
    const headers = headersFor(ORG_A);
    const first = await list(headers, "?page=1&pageSize=3");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ page: 1, pageSize: 3, total: 4 });
    expect(first.body.items).toHaveLength(3);
    const second = await list(headers, "?page=2&pageSize=3");
    expect(second.body).toMatchObject({ page: 2, pageSize: 3, total: 4 });
    expect(second.body.items).toHaveLength(1);
    const ids = [...first.body.items, ...second.body.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain(orgBApproval);
    const defaults = await list(headers, "?page=1");
    expect(defaults.body).toMatchObject({ page: 1, pageSize: 20, total: 4 });
    expect((await list(headers, "?pageSize=500")).body.pageSize).toBe(100);
    expect((await list(headers, "?page=0")).status).toBe(400);
    expect((await list(headers, "?pageSize=abc")).status).toBe(400);
  });

  it("other department sees only its own; unknown org sees nothing", async () => {
    const b = await list(headersFor(ORG_B), "?page=1&pageSize=20");
    expect(b.body.total).toBe(1);
    expect(b.body.items.map((i) => i.id)).toEqual([orgBApproval]);
    const none = await list(headersFor(id26("ITNONE")), "?page=1");
    expect(none.body).toMatchObject({ total: 0, items: [] });
  });

  it("adds tool_name and masked args_preview; raw args never in the response", async () => {
    const res = await list(headersFor(ORG_A), "?page=1&pageSize=20");
    const item = res.body.items.find((i) => i.id === orgAApprovals[0])!;
    expect(item).toMatchObject({ tool_name: "mail.send", agent_id: agentId, agent_name: "IT approvals agent", status: "pending" });
    // MySQL JSON normalises key order, so assert on the parts.
    const parts = item.args_preview!.split(", ").sort();
    expect(parts).toEqual(["api_key=***", `body=${"z".repeat(79)}…`, "subject=周报", "to=user0@example.com"]);
    const missing = res.body.items.find((i) => i.id === noToolApproval)!;
    expect(missing.tool_name).toBeNull();
    expect(missing.args_preview).toBeNull();
    expect(res.raw).not.toContain(SECRET);
    expect(res.raw).not.toContain("z".repeat(81));
    for (const it of res.body.items) expect(Object.keys(it)).not.toEqual(expect.arrayContaining(["args_json", "args", "tool_args"]));

    const adminRes = await list(adminHeaders, "?page=1&pageSize=100");
    expect(adminRes.raw).not.toContain(SECRET);
    const b = adminRes.body.items.find((i) => i.id === orgBApproval);
    if (b) expect(b).toMatchObject({ tool_name: "crm.update", args_preview: "note=other dept, nested={password=***}" });
    expect(adminRes.body.total).toBeGreaterThanOrEqual(5);
  });
});
