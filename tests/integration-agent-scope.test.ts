import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// L follow-up (I-INT-17): /integration/v1/agents and POST /integration/v1/runs reuse agentAccessible — the mapped
// user sees Agents owned by its department subtree (and unowned ones); others are hidden from the list and 404 on
// run (no Run written). Disabled Agents are not listed and 409 CFG-8503 on run (after the scope check).
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const id26 = (tag: string): string => `${tag}${randomBytes(16).toString("hex").toUpperCase()}`.slice(0, 26);
const ORG_A = id26("ITIA");
const ORG_A1 = id26("ITIC");
const ORG_B = id26("ITIB");
const issuer = "forge-int-scope";
const audience = "forge-int-scope";
let app: FastifyInstance;
let privateKey: CryptoKey;
let userId = "";
const agents: Record<string, { id: string; key: string }> = {};

const token = () =>
  new SignJWT({ principalType: "user", application: "scope", environment: "test", roles: [], subject: `it-is-sub-${suffix}` })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
const auth = async () => ({ authorization: `Bearer ${await token()}` });
const runsOf = async (agentId: string) => (await query("SELECT id FROM runs WHERE agent_id = ?", [agentId])).length;
const startRun = async (name: string) =>
  app.inject({ method: "POST", url: "/integration/v1/runs", headers: await auth(), payload: { agentKey: agents[name]!.key, text: "hi" } });

async function agent(name: string, owner: string | null, status = "active") {
  const key = `it-is-${name}-${suffix}`;
  const id = await repos.createAgent({ key, name: `IT ${name}`, ownerOrgUnitId: owner, createdBy: ADMIN_ID });
  const versionId = await repos.createAgentVersion({ agentId: id, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
  await repos.publishAgentVersion(id, versionId, { expectedRevision: "system" });
  if (status !== "active") await repos.updateAgent(id, { status }, { expectedRevision: "system" });
  agents[name] = { id, key };
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
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [ORG_A, ROOT, `it-is-a-${suffix}`, "IT A", `/it-is-a-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [ORG_A1, ORG_A, `it-is-a1-${suffix}`, "IT A1", `/it-is-a-${suffix}/it-is-a1-${suffix}/`]);
  await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, ?, ?, ?, ?)", [ORG_B, ROOT, `it-is-b-${suffix}`, "IT B", `/it-is-b-${suffix}/`]);
  userId = await repos.createUser({ email: `it-is-${suffix}@forge.local`, username: `it-is-${suffix}`, displayName: "IT is", role: "operator", dataScope: "org", orgUnitId: ORG_A, idpSubject: `it-is-sub-${suffix}` });
  await agent("own", ORG_A);
  await agent("child", ORG_A1);
  await agent("other", ORG_B);
  await agent("unowned", null);
  await agent("disabled", ORG_A, "disabled");
  await agent("otherdisabled", ORG_B, "disabled");
});

afterAll(async () => {
  for (const { id } of Object.values(agents)) {
    await execute("DELETE FROM runs WHERE agent_id = ?", [id]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [id]);
    await execute("UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE id = ?", [id]);
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [id]);
    await execute("DELETE FROM agents WHERE id = ?", [id]);
  }
  await execute("DELETE FROM users WHERE id = ?", [userId]);
  await execute("DELETE FROM org_units WHERE id IN (?, ?, ?)", [ORG_A1, ORG_A, ORG_B]);
  await app?.close();
});

describe("integration Agent scope (I-INT-17)", () => {
  it("GET /integration/v1/agents lists own + child department + unowned; not other department, not disabled", async () => {
    const res = await app.inject({ method: "GET", url: "/integration/v1/agents", headers: await auth() });
    expect(res.statusCode, res.body).toBe(200);
    const keys = (res.json() as { items: Array<{ key: string }> }).items.map((item) => item.key);
    for (const name of ["own", "child", "unowned"]) expect(keys).toContain(agents[name]!.key);
    for (const name of ["other", "disabled", "otherdisabled"]) expect(keys).not.toContain(agents[name]!.key);
  });

  it("POST /integration/v1/runs on another department's Agent -> 404, no Run", async () => {
    const res = await startRun("other");
    expect(res.statusCode, res.body).toBe(404);
    expect(await runsOf(agents.other!.id)).toBe(0);
  });

  it("out-of-scope + disabled -> still 404 (scope checked first)", async () => {
    expect((await startRun("otherdisabled")).statusCode).toBe(404);
  });

  it("disabled Agent in scope -> 409 CFG-8503, no Run", async () => {
    const res = await startRun("disabled");
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("CFG-8503");
    expect(await runsOf(agents.disabled!.id)).toBe(0);
  });

  for (const name of ["own", "child", "unowned"]) {
    it(`POST /integration/v1/runs on ${name} Agent -> 202`, async () => {
      const res = await startRun(name);
      expect(res.statusCode, res.body).toBe(202);
      expect(await runsOf(agents[name]!.id)).toBe(1);
    });
  }
});
