import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, parseJsonValue, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P3-10 (architect ruling 3): an audit row written while serving a request carries ip, userAgent (at most 512
// characters) and requestId inside details_json (no new column, no migration). ip is request.ip: X-Forwarded-For is
// honoured only when the app is built with trustProxy; by default a forged XFF is ignored. Rows written outside a
// request (worker, scripts) get none of the keys.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let proxied: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";

type Details = Record<string, unknown>;
async function makeRun(): Promise<string> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  return repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "x" }, status: "queued" });
}
async function cancelDetails(target: FastifyInstance, extra: Record<string, string>): Promise<Details> {
  const runId = await makeRun();
  const res = await target.inject({ method: "POST", url: `/admin/api/runs/${runId}/cancel`, headers: { ...headers, ...extra } });
  expect(res.statusCode, res.body).toBe(200);
  const rows = await query<{ details_json: unknown }>("SELECT details_json FROM audit_logs WHERE action = 'run.cancel' AND resource_id = ?", [runId]);
  expect(rows).toHaveLength(1);
  return parseJsonValue<Details>(rows[0]!.details_json, {});
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  proxied = await buildApp({ logger: false, trustProxy: true });
  await proxied.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  agentId = await repos.createAgent({ key: `it-p310-${suffix}`, name: "IT p310", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
});

afterAll(async () => {
  if (agentId) {
    await execute("DELETE a FROM audit_logs a JOIN runs r ON r.id = a.resource_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  }
  await execute("DELETE FROM audit_logs WHERE action = 'it.p310.background' AND resource_id = ?", [`it-p310-${suffix}`]);
  await cleanupRealSessions();
  await app?.close();
  await proxied?.close();
});

describe("P3-10 audit details carry ip / userAgent / requestId", () => {
  it("default (no trustProxy): ip = socket address, a forged X-Forwarded-For is ignored", async () => {
    const details = await cancelDetails(app, { "x-forwarded-for": "203.0.113.9, 198.51.100.7", "user-agent": "ua-p310/1.0", "x-request-id": `req-p310-${suffix}` });
    expect(details).toEqual({ ip: "127.0.0.1", userAgent: "ua-p310/1.0", requestId: `req-p310-${suffix}` });
    expect(JSON.stringify(details)).not.toMatch(/203\.0\.113\.9|198\.51\.100\.7/);
  });

  it("trustProxy configured: ip comes from X-Forwarded-For (client end)", async () => {
    const details = await cancelDetails(proxied, { "x-forwarded-for": "203.0.113.9" });
    expect(details.ip).toBe("203.0.113.9");
  });

  it("userAgent is truncated to 512 characters; requestId defaults to the generated request id", async () => {
    const ua = `${"U".repeat(510)}é漢${"Z".repeat(300)}`;
    const details = await cancelDetails(app, { "user-agent": ua });
    expect(details.userAgent).toBe(ua.slice(0, 512));
    expect(String(details.userAgent)).toHaveLength(512);
    expect(typeof details.requestId).toBe("string");
    expect(String(details.requestId).length).toBeGreaterThan(0);
  });

  it("no User-Agent header -> userAgent null", async () => {
    const details = await cancelDetails(app, { "user-agent": "" });
    expect(details).toMatchObject({ ip: "127.0.0.1", userAgent: null });
  });

  it("an audit written outside a request has none of the keys", async () => {
    await repos.audit({ actorType: "system", actorId: null, action: "it.p310.background", resourceType: "run", resourceId: `it-p310-${suffix}`, details: { a: 1 }, orgUnitId: null });
    const rows = await query<{ details_json: unknown }>("SELECT details_json FROM audit_logs WHERE action = 'it.p310.background' AND resource_id = ?", [`it-p310-${suffix}`]);
    expect(parseJsonValue(rows[0]!.details_json, {})).toEqual({ a: 1 });
  });
});
