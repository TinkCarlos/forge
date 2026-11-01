import { configurationHeaders } from "./helpers/configuration-headers.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { config, hashApiKey } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { triggerSchedule } from "@forge/runtime";
import { execute, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// Item F (needs a *_test DB): an Agent installed by a plugin whose stored manifest_json is not a JSON object (item A) is
// unusable. Every Run entry (admin run, /open runs + invoke, /integration runs, schedule tick, schedule run-now) refuses it
// with the existing 409 CFG-8503 and queues nothing. The agent row is not touched; once the manifest is an object again
// the same agent runs. Agents of a healthy plugin and agents not installed by a plugin are unaffected.
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const k = (tag: string) => `it-pau-${tag}-${suffix}`;
const issuer = "forge-pau";
let app: FastifyInstance;
let connectorApp: FastifyInstance;
let privateKey: CryptoKey;
let headers: Record<string, string> = {};
let appId = "";
let openKey = "";
let connectorUserId = "";
let accountId = "";
const agents: Record<string, { id: string; key: string; versionId: string }> = {};
const pluginIds: Record<string, string> = {};
const schedules: string[] = [];

const connectorToken = () =>
  new SignJWT({ principalType: "user", application: "pau", environment: "test", roles: [], subject: k("sub") })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(issuer).setIssuedAt().setExpirationTime("5m").sign(privateKey);
const runCount = async (agentId: string) => (await query<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?", [agentId]))[0]!.n;
const setManifest = (tag: string, broken: boolean) =>
  broken ? execute("UPDATE plugins SET manifest_json = ? WHERE id = ?", ["[1]", pluginIds[tag]]) : execute("UPDATE plugins SET manifest_json = JSON_OBJECT('name', ?) WHERE id = ?", [tag, pluginIds[tag]]);

async function makeSchedule(agentId: string): Promise<string> {
  const id = await repos.createSchedule({
    key: k(`sch-${schedules.length}`), name: "IT pau", agentId, orgUnitId: ROOT, subjectType: "service", subjectId: accountId, serviceAccountId: accountId,
    cron: "0 9 * * *", timezone: "Asia/Shanghai", input: { text: "x" }, status: "active", nextRunAt: new Date(Date.now() - 1000), createdBy: ADMIN_ID,
  });
  schedules.push(id);
  return id;
}

type Entry = { name: string; call: (tag: string) => Promise<{ ok: boolean; status: number; code?: string }> };
const http = (res: LightMyRequestResponse) => {
  const code = res.statusCode >= 400 ? (res.json() as { error: { code: string } }).error.code : undefined;
  return { ok: res.statusCode < 300, status: res.statusCode, code };
};
const entries: Entry[] = [
  { name: "admin POST /admin/api/agents/:id/run", call: async (tag) => http(await app.inject({ method: "POST", url: `/admin/api/agents/${agents[tag]!.id}/run`, headers: await configurationHeaders(`/admin/api/agents/${agents[tag]!.id}/run`, headers), payload: { text: "hi" } })) },
  { name: "open POST /open/v1/agents/:key/runs", call: async (tag) => http(await app.inject({ method: "POST", url: `/open/v1/agents/${agents[tag]!.key}/runs`, headers: { authorization: `Bearer ${openKey}` }, payload: { text: "hi" } })) },
  { name: "open POST /open/v1/agents/:key/invoke", call: async (tag) => http(await app.inject({ method: "POST", url: `/open/v1/agents/${agents[tag]!.key}/invoke?wait=0`, headers: { authorization: `Bearer ${openKey}` }, payload: { text: "hi" } })) },
  { name: "integration POST /integration/v1/runs", call: async (tag) => http(await connectorApp.inject({ method: "POST", url: "/integration/v1/runs", headers: { authorization: `Bearer ${await connectorToken()}` }, payload: { agentKey: agents[tag]!.key, text: "hi" } })) },
  { name: "admin POST /admin/api/schedules/:id/run", call: async (tag) => http(await app.inject({ method: "POST", url: `/admin/api/schedules/${await makeSchedule(agents[tag]!.id)}/run`, headers: await configurationHeaders(`/admin/api/schedules/${await makeSchedule(agents[tag]!.id)}/run`, headers), payload: {} })) },
  {
    name: "schedule tick (triggerSchedule)",
    call: async (tag) => {
      const id = await makeSchedule(agents[tag]!.id);
      const result = await triggerSchedule((await repos.getSchedule(id))!);
      const after = await repos.getSchedule(id);
      expect(after?.status, "the schedule stays active (only this occurrence is skipped)").toBe("active");
      return { ok: result.kind === "run", status: 0, code: "code" in result ? result.code : undefined };
    },
  },
];

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  connectorApp = await buildApp({
    logger: false,
    config: {
      AGENT_CONNECTOR_ENABLED: true, AGENT_CONNECTOR_INBOUND_ENABLED: true, AGENT_CONNECTOR_LEGACY_FALLBACK_ENABLED: false,
      AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64: Buffer.from(await exportSPKI(pair.publicKey)).toString("base64"),
      AGENT_CONNECTOR_ENVIRONMENT: "test", CONNECTOR_PRINCIPAL_ISSUER: issuer, CONNECTOR_PRINCIPAL_AUDIENCE: issuer,
    },
  });
  await connectorApp.ready();
  const admin = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(admin, sessionCookieValue(admin));
  for (const tag of ["broken", "healthy", "plain"]) {
    const id = await repos.createAgent({ key: k(tag), name: `IT pau ${tag}`, ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
    const versionId = await repos.createAgentVersion({ agentId: id, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
    await repos.publishAgentVersion(id, versionId, { expectedRevision: "system" });
    await repos.updateAgent(id, { api_enabled: 1 }, { expectedRevision: "system" });
    agents[tag] = { id, key: k(tag), versionId };
  }
  for (const tag of ["broken", "healthy"]) {
    pluginIds[tag] = await repos.createPlugin({ key: k(`plg-${tag}`), version: "1.0.0", type: "agent", name: tag, manifest: { name: tag }, resources: { agents: [agents[tag]!.id] } });
  }
  await setManifest("broken", true);
  appId = await repos.createApiApp({ key: k("app"), name: "IT pau", ownerOrgUnitId: ROOT, scopes: ["runs:create", "runs:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it", prefix: openKey.slice(0, 16), keyHash: hashApiKey(openKey, config.API_KEY_PEPPER), scopes: ["runs:create", "runs:read"] });
  connectorUserId = await repos.createUser({ email: `${k("u")}@forge.local`, username: k("u"), displayName: "IT", role: "operator", dataScope: "org", orgUnitId: ROOT, idpSubject: k("sub") });
  accountId = await repos.createServiceAccount({ key: k("svc"), name: "IT pau svc", orgUnitId: ROOT, role: "operator", dataScope: "org", createdBy: ADMIN_ID });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
  for (const id of schedules) await execute("DELETE FROM schedules WHERE id = ?", [id]);
  await execute("DELETE FROM plugins WHERE id IN (?, ?)", [pluginIds.broken, pluginIds.healthy]);
  for (const { id, versionId } of Object.values(agents)) {
    await execute("UPDATE runs SET status = 'cancelled' WHERE agent_id = ? AND status IN ('queued','running')", [id]);
    await execute("DELETE FROM audit_logs WHERE resource_type = 'run' AND resource_id IN (SELECT id FROM runs WHERE agent_id = ?)", [id]);
    for (const table of ["messages", "run_events", "run_steps"]) await execute(`DELETE x FROM ${table} x JOIN runs r ON r.id = x.run_id WHERE r.agent_id = ?`, [id]);
    await execute("DELETE FROM runs WHERE agent_id = ?", [id]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [id]);
    await execute("DELETE FROM audit_logs WHERE resource_type = 'agent' AND resource_id = ?", [id]);
    await execute("UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE id = ?", [id]);
    await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
    await execute("DELETE FROM agents WHERE id = ?", [id]);
  }
  await execute("DELETE FROM api_keys WHERE app_id = ?", [appId]);
  await execute("DELETE FROM api_apps WHERE id = ?", [appId]);
  await execute("DELETE FROM users WHERE id = ?", [connectorUserId]);
  await execute("DELETE FROM service_accounts WHERE id = ?", [accountId]);
  await cleanupRealSessions();
  await app?.close();
  await connectorApp?.close();
});

describe("item F: an agent of a manifest-invalid plugin cannot be run", () => {
  it.each(entries.map((e) => [e.name, e] as const))("%s: broken plugin -> refused (CFG-8503), no Run; healthy-plugin and plain agents run", async (_name, entry) => {
    const before = await runCount(agents.broken!.id);
    const refused = await entry.call("broken");
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("CFG-8503");
    if (refused.status) expect(refused.status).toBe(409);
    expect(await runCount(agents.broken!.id)).toBe(before);
    for (const tag of ["healthy", "plain"]) {
      const n = await runCount(agents[tag]!.id);
      expect((await entry.call(tag)).ok, tag).toBe(true);
      expect(await runCount(agents[tag]!.id)).toBe(n + 1);
    }
  });

  it("the agent row is untouched and the same agent runs again on every entry once the manifest is fixed", async () => {
    const row = await repos.getAgent(agents.broken!.id);
    expect(row?.status).toBe("active");
    expect(row?.published_version_id).toBe(agents.broken!.versionId);
    await setManifest("broken", false);
    try {
      for (const entry of entries) {
        const n = await runCount(agents.broken!.id);
        expect((await entry.call("broken")).ok, entry.name).toBe(true);
        expect(await runCount(agents.broken!.id)).toBe(n + 1);
      }
    } finally {
      await setManifest("broken", true);
    }
  });
});
