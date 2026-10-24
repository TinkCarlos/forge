import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// I-AGT-13: an Agent without owner_org_unit_id may only be written (PATCH, new version, publish) by platform_admin;
// others get 403 POL-2001 with nothing written and no audit. Reading and running it stay open as before.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
let app: FastifyInstance;
const H: Record<string, Record<string, string>> = {};
let unowned = "";
let unownedVersion = "";
let owned = "";

const code = (body: string) => (JSON.parse(body) as { error?: { code: string } }).error?.code;
const writes = (agentId: string, versionId: string) => [
  { name: "PATCH", method: "PATCH" as const, url: `/admin/api/agents/${agentId}`, payload: { name: "renamed" } },
  { name: "create version", method: "POST" as const, url: `/admin/api/agents/${agentId}/versions`, payload: { version: `9.${Date.now() % 1000}.0`, publish: true } },
  { name: "publish", method: "POST" as const, url: `/admin/api/agents/${agentId}/publish`, payload: { versionId } },
];
const agentAudits = async (agentId: string) =>
  (await query("SELECT id FROM audit_logs WHERE resource_id = ? OR JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.agentId')) = ?", [agentId, agentId])).length;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  for (const role of ["platform_admin", "org_admin", "builder"] as const) {
    const s = await realSession({ role, orgUnitId: ROOT, dataScope: role === "platform_admin" ? "all" : "org" });
    H[role] = sessionHeaders(s, sessionCookieValue(s));
  }
  unowned = await repos.createAgent({ key: `it-uaw-none-${suffix}`, name: "IT unowned", ownerOrgUnitId: null, createdBy: ADMIN_ID });
  unownedVersion = await repos.createAgentVersion({ agentId: unowned, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(unowned, unownedVersion);
  owned = await repos.createAgent({ key: `it-uaw-own-${suffix}`, name: "IT owned", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
});

afterAll(async () => {
  for (const id of [unowned, owned].filter(Boolean)) {
    await execute("DELETE FROM audit_logs WHERE resource_id = ? OR JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.agentId')) = ?", [id, id]);
    await execute("DELETE t FROM tool_calls t JOIN runs r ON r.id = t.run_id WHERE r.agent_id = ?", [id]);
    await execute("DELETE m FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.agent_id = ?", [id]).catch(() => undefined);
    await execute("DELETE FROM runs WHERE agent_id = ?", [id]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [id]);
    await execute("UPDATE agents SET published_version_id = NULL WHERE id = ?", [id]).catch(() => undefined);
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [id]);
    await execute("DELETE FROM agents WHERE id = ?", [id]);
  }
  await cleanupRealSessions();
  await app?.close();
});

describe("unowned Agent writes (I-AGT-13)", () => {
  for (const role of ["org_admin", "builder"]) {
    for (const w of writes("UNOWNED", "VERSION")) {
      it(`${role} ${w.name} on unowned -> 403 POL-2001, nothing written, no audit`, async () => {
        const target = writes(unowned, unownedVersion).find((x) => x.name === w.name)!;
        const before = await repos.getAgent(unowned);
        const versionsBefore = (await repos.listAgentVersions(unowned)).length;
        const res = await app.inject({ method: target.method, url: target.url, headers: H[role]!, payload: target.payload });
        expect(res.statusCode, res.body).toBe(403);
        expect(code(res.body)).toBe("POL-2001");
        const after = await repos.getAgent(unowned);
        expect(after!.name).toBe(before!.name);
        expect(after!.published_version_id).toBe(before!.published_version_id);
        expect((await repos.listAgentVersions(unowned)).length).toBe(versionsBefore);
        expect(await agentAudits(unowned)).toBe(0);
      });
    }
  }

  it("org_admin / builder can still read the unowned Agent", async () => {
    for (const role of ["org_admin", "builder"]) {
      const res = await app.inject({ method: "GET", url: `/admin/api/agents/${unowned}`, headers: H[role]! });
      expect(res.statusCode, res.body).toBe(200);
    }
  });

  it("builder can still run the unowned Agent (not 403)", async () => {
    const res = await app.inject({ method: "POST", url: `/admin/api/agents/${unowned}/run`, headers: H.builder!, payload: { input: { text: "hi" } } });
    expect(res.statusCode, res.body).not.toBe(403);
    expect(res.statusCode).toBeLessThan(300);
  });

  it("platform_admin can PATCH, create a version and publish the unowned Agent", async () => {
    const [patch, version] = writes(unowned, unownedVersion);
    expect((await app.inject({ method: patch!.method, url: patch!.url, headers: H.platform_admin!, payload: patch!.payload })).statusCode).toBe(200);
    const created = await app.inject({ method: version!.method, url: version!.url, headers: H.platform_admin!, payload: { version: "2.0.0" } });
    expect(created.statusCode, created.body).toBe(200);
    const versionId = (created.json() as { versionId: string }).versionId;
    expect((await app.inject({ method: "POST", url: `/admin/api/agents/${unowned}/publish`, headers: H.platform_admin!, payload: { versionId } })).statusCode).toBe(200);
  });

  it("owned Agent in the caller's department is still writable by builder", async () => {
    const res = await app.inject({ method: "PATCH", url: `/admin/api/agents/${owned}`, headers: H.builder!, payload: { name: "owned renamed" } });
    expect(res.statusCode, res.body).toBe(200);
  });
});
