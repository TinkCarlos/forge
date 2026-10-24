import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// P0-04 / P0-05 (I-INT-11 / I-INT-15), needs a *_test DB. The only caller of /integration/v1/* is a Connector
// principal mapped to a Forge user, so the user's functional permissions apply: starting a run needs agent.run,
// cancelling needs run.cancel (403 POL-2001, checked before the scope checks agentAccessible / assertRunAccess,
// which stay). On 403 the runs table is unchanged (count and status) and nothing is audited.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const issuer = "forge-int-perm";
const audience = "forge-int-perm";
let app: FastifyInstance;
let privateKey: CryptoKey;
let agentId = "";
let agentKey = "";
let versionId = "";
const users: Record<string, string> = {};
const runs: Record<string, string> = {};

const auth = async (who: string) => ({
  authorization: `Bearer ${await new SignJWT({ principalType: "user", application: "perm", environment: "test", roles: [], subject: `it-ip-${who}-${suffix}` })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey)}`,
});
const runCount = async () => Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?", [agentId]))[0]!.n);
const statusOf = async (runId: string) => (await query<{ status: string }>("SELECT status FROM runs WHERE id = ?", [runId]))[0]!.status;
const auditCount = async (action: string) =>
  Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = ? AND actor_id IN (?, ?, ?)", [action, users.auditor, users.user, users.operator]))[0]!.n);

async function queuedRun(owner: string): Promise<string> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: owner });
  return repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: owner, input: { text: "x" }, status: "queued" });
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  app = await buildApp({
    logger: false,
    config: {
      AGENT_CONNECTOR_ENABLED: true, AGENT_CONNECTOR_INBOUND_ENABLED: true, AGENT_CONNECTOR_LEGACY_FALLBACK_ENABLED: false,
      AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64: Buffer.from(await exportSPKI(pair.publicKey)).toString("base64"),
      AGENT_CONNECTOR_ENVIRONMENT: "test", CONNECTOR_PRINCIPAL_ISSUER: issuer, CONNECTOR_PRINCIPAL_AUDIENCE: audience,
    },
  });
  await app.ready();
  agentKey = `it-ip-${suffix}`;
  agentId = await repos.createAgent({ key: agentKey, name: "IT ip", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(agentId, versionId);
  for (const [role, dataScope] of [["auditor", "org"], ["user", "self"], ["operator", "org"]] as const) {
    users[role] = await repos.createUser({ email: `it-ip-${role}-${suffix}@forge.local`, username: `it-ip-${role}-${suffix}`, displayName: `IT ip ${role}`, role, dataScope, orgUnitId: ROOT, idpSubject: `it-ip-${role}-${suffix}` });
  }
  runs.auditor = await queuedRun(users.auditor!);
  runs.user = await queuedRun(users.user!);
  runs.operator = await queuedRun(users.operator!);
});

afterAll(async () => {
  await execute("DELETE FROM audit_logs WHERE actor_id IN (?, ?, ?)", [users.auditor, users.user, users.operator]);
  await execute("DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE agent_id = ?)", [agentId]);
  await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE id = ?", [agentId]);
  await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  await execute("DELETE FROM users WHERE id IN (?, ?, ?)", [users.auditor, users.user, users.operator]);
  await app?.close();
});

describe("P0-04 POST /integration/v1/runs needs agent.run", () => {
  it("auditor (no agent.run) -> 403 POL-2001, no new run, no audit", async () => {
    const before = await runCount();
    const res = await app.inject({ method: "POST", url: "/integration/v1/runs", headers: await auth("auditor"), payload: { agentKey, text: "hi" } });
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("POL-2001");
    expect(await runCount()).toBe(before);
    expect(await auditCount("integration.run.create")).toBe(0);
  });
  it("user (has agent.run) -> 202, one new run", async () => {
    const before = await runCount();
    const res = await app.inject({ method: "POST", url: "/integration/v1/runs", headers: await auth("user"), payload: { agentKey, text: "hi" } });
    expect(res.statusCode, res.body).toBe(202);
    expect(await runCount()).toBe(before + 1);
  });
});

describe("P0-05 POST /integration/v1/runs/:id/cancel needs run.cancel", () => {
  for (const who of ["auditor", "user"] as const) {
    it(`${who} (no run.cancel) cancelling its own queued run -> 403, run still queued, no audit`, async () => {
      const res = await app.inject({ method: "POST", url: `/integration/v1/runs/${runs[who]}/cancel`, headers: await auth(who) });
      expect(res.statusCode, res.body).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("POL-2001");
      expect(await statusOf(runs[who]!)).toBe("queued");
      expect(await auditCount("integration.run.cancel")).toBe(0);
    });
  }
  it("operator (has run.cancel) -> 200, run cancelled", async () => {
    const res = await app.inject({ method: "POST", url: `/integration/v1/runs/${runs.operator}/cancel`, headers: await auth("operator") });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(runs.operator!)).toBe("cancelled");
  });
});
