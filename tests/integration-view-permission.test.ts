import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { ROLE_PERMISSIONS } from "@forge/core";
import { execute, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// F9 (P1, needs a *_test DB): the Connector read routes check the mapped user's functional permission first —
// GET /integration/v1/agents needs agent.view, GET /integration/v1/runs/:id and /result need run.view (403 POL-2001,
// before the scope checks agentAccessible / assertRunAccess, which stay). Every built-in role holds both permissions
// today, so the test removes them from the mapped user's role for the duration of one request (ROLE_PERMISSIONS is
// the table hasPermission reads) — the situation of a future role without them.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const issuer = "forge-int-view";
const audience = "forge-int-view";
let app: FastifyInstance;
let privateKey: CryptoKey;
let agentId = "";
let agentKey = "";
let versionId = "";
let userId = "";
let runId = "";

const auth = async () => ({
  authorization: `Bearer ${await new SignJWT({ principalType: "user", application: "view", environment: "test", roles: [], subject: `it-iv-${suffix}` })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey)}`,
});

async function without<T>(permission: string, fn: () => Promise<T>): Promise<T> {
  const list = ROLE_PERMISSIONS.auditor;
  const saved = [...list];
  list.splice(0, list.length, ...saved.filter((p) => p !== permission));
  try {
    return await fn();
  } finally {
    list.splice(0, list.length, ...saved);
  }
}
const get = async (url: string) => app.inject({ method: "GET", url, headers: await auth() });
const codeOf = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code;

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
  agentKey = `it-iv-${suffix}`;
  agentId = await repos.createAgent({ key: agentKey, name: "IT iv", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  await repos.publishAgentVersion(agentId, versionId);
  userId = await repos.createUser({ email: `it-iv-${suffix}@forge.local`, username: `it-iv-${suffix}`, displayName: "IT iv", role: "auditor", dataScope: "org", orgUnitId: ROOT, idpSubject: `it-iv-${suffix}` });
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: userId });
  runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: userId, input: { text: "x" }, status: "succeeded" });
});

afterAll(async () => {
  await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE id = ?", [agentId]);
  await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  await execute("DELETE FROM users WHERE id = ?", [userId]);
  await app?.close();
});

describe("F9: Connector GET routes check the functional permission", () => {
  it("GET /integration/v1/agents without agent.view -> 403 POL-2001; with it -> 200 listing the Agent", async () => {
    const denied = await without("agent.view", () => get("/integration/v1/agents"));
    expect([denied.statusCode, codeOf(denied)]).toEqual([403, "POL-2001"]);
    const ok = await get("/integration/v1/agents");
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as { items: Array<{ key: string }> }).items.map((i) => i.key)).toContain(agentKey);
  });

  for (const tail of ["", "/result"]) {
    it(`GET /integration/v1/runs/:id${tail} on its own run without run.view -> 403; with it -> 200`, async () => {
      const denied = await without("run.view", () => get(`/integration/v1/runs/${runId}${tail}`));
      expect([denied.statusCode, codeOf(denied)]).toEqual([403, "POL-2001"]);
      const ok = await get(`/integration/v1/runs/${runId}${tail}`);
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it(`GET /integration/v1/runs/:id${tail} on an unknown run: 403 without run.view (before 404), 404 with it`, async () => {
      const unknown = "01J0000000000000000000ZZZZ";
      const denied = await without("run.view", () => get(`/integration/v1/runs/${unknown}${tail}`));
      expect(denied.statusCode).toBe(403);
      expect((await get(`/integration/v1/runs/${unknown}${tail}`)).statusCode).toBe(404);
    });
  }
});
