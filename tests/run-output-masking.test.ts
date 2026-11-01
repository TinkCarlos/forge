import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { config, hashApiKey } from "@forge/core";
import { sessionCookieValue } from "@forge/identity";
import { execute, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P1 (architect, U-12 follow-up; needs a *_test DB): run.output_json leaves the server masked with the same structured
// rules as input / tool results (maskArgsDeep: sensitive keys, Bearer/sk-/JWT values, URL query secrets, embedded
// JSON) in all three APIs: admin GET /admin/api/runs/:id, open GET /open/v1/runs/:id and /result, integration GET
// /integration/v1/runs/:id and /result. The stored row is unchanged. A static check keeps raw output_json out of
// every route response (also the open invoke wait body).
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const issuer = "forge-out-mask";
const audience = "forge-out-mask";
const SECRETS = ["tok-SEKRET-1", "pw-SEKRET-2", "sk-SEKRETSEKRETSEKRET3", "q-SEKRET-4", "nested-SEKRET-5"];
const OUTPUT = {
  text: "done",
  data: { access_token: "tok-SEKRET-1", items: [{ password: "pw-SEKRET-2", id: 7 }], status: "ok" },
  auth: "Bearer sk-SEKRETSEKRETSEKRET3",
  link: "https://api.example.com/cb?token=q-SEKRET-4&page=2",
  raw: JSON.stringify({ client_secret: "nested-SEKRET-5", ok: true }),
};
let app: FastifyInstance;
let privateKey: CryptoKey;
let adminHeaders: Record<string, string> = {};
let openKey = "";
const ids: Record<string, string> = {};

const connector = async () => ({
  authorization: `Bearer ${await new SignJWT({ principalType: "user", application: "om", environment: "test", roles: [], subject: `it-om-${suffix}` })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey)}`,
});

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
  const pa = await realSession({ name: "IT om", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  adminHeaders = sessionHeaders(pa, sessionCookieValue(pa));
  ids.agent = await repos.createAgent({ key: `it-om-${suffix}`, name: "IT om", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  await repos.updateAgent(ids.agent, { api_enabled: 1 }, { expectedRevision: "system" });
  ids.version = await repos.createAgentVersion({ agentId: ids.agent, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
  await repos.publishAgentVersion(ids.agent, ids.version, { expectedRevision: "system" });
  ids.user = await repos.createUser({ email: `it-om-${suffix}@forge.local`, username: `it-om-${suffix}`, displayName: "IT om", role: "operator", dataScope: "org", orgUnitId: ROOT, idpSubject: `it-om-${suffix}` });
  ids.app = await repos.createApiApp({ key: `it-om-${suffix}`, name: "IT om", ownerOrgUnitId: ROOT, scopes: ["runs:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId: ids.app, name: "it", prefix: openKey.slice(0, 16), keyHash: hashApiKey(openKey, config.API_KEY_PEPPER), scopes: ["runs:read"] });
  const thread = await repos.createThread({ agentId: ids.agent, orgUnitId: ROOT, subjectType: "user", subjectId: ids.user });
  ids.run = await repos.createRun({ threadId: thread, agentId: ids.agent, agentVersionId: ids.version, appId: ids.app, orgUnitId: ROOT, subjectType: "user", subjectId: ids.user, input: { text: "x" }, status: "succeeded" });
  await execute("UPDATE runs SET output_json = ? WHERE id = ?", [JSON.stringify(OUTPUT), ids.run]);
  await repos.addEvent(ids.run, "run.completed", { status: "succeeded", output: OUTPUT, error: null });
});

afterAll(async () => {
  await execute("DELETE FROM runs WHERE agent_id = ?", [ids.agent]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [ids.agent]);
  await execute("DELETE FROM api_keys WHERE app_id = ?", [ids.app]);
  await execute("DELETE FROM api_apps WHERE id = ?", [ids.app]);
  await execute("UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE id = ?", [ids.agent]);
  await execute("DELETE FROM agent_versions WHERE agent_id = ?", [ids.agent]);
  await execute("DELETE FROM agents WHERE id = ?", [ids.agent]);
  await execute("DELETE FROM users WHERE id = ?", [ids.user]);
  await cleanupRealSessions();
  await app?.close();
});

function expectMasked(output: unknown) {
  const text = JSON.stringify(output);
  for (const s of SECRETS) expect(text, s).not.toContain(s);
  const o = output as typeof OUTPUT;
  expect(o.text).toBe("done");
  expect(o.data.status).toBe("ok");
  expect(o.data.items[0]!.id).toBe(7);
  expect(o.data.access_token).toBe("***");
  expect(o.auth).toBe("***");
  expect(o.link).toContain("page=2");
  expect(JSON.parse(o.raw)).toEqual({ client_secret: "***", ok: true });
}

describe("P1: run output_json is masked in admin, open and integration APIs", () => {
  const cases: Array<[string, () => Promise<Record<string, string>>, string]> = [
    ["admin GET /admin/api/runs/:id", async () => adminHeaders, "/admin/api/runs/{id}"],
    ["open GET /open/v1/runs/:id", async () => ({ authorization: `Bearer ${openKey}` }), "/open/v1/runs/{id}"],
    ["open GET /open/v1/runs/:id/result", async () => ({ authorization: `Bearer ${openKey}` }), "/open/v1/runs/{id}/result"],
    ["integration GET /integration/v1/runs/:id", connector, "/integration/v1/runs/{id}"],
    ["integration GET /integration/v1/runs/:id/result", connector, "/integration/v1/runs/{id}/result"],
  ];
  it.each(cases)("%s", async (_name, headers, url) => {
    const res = await app.inject({ method: "GET", url: url.replace("{id}", ids.run!), headers: await headers() });
    expect(res.statusCode, res.body).toBe(200);
    expectMasked((res.json() as { output: unknown }).output);
  });

  it.each([
    ["admin", async () => adminHeaders, "/admin/api/runs/{id}/events"],
    ["open", async () => ({ authorization: `Bearer ${openKey}` }), "/open/v1/runs/{id}/events"],
  ] as Array<[string, () => Promise<Record<string, string>>, string]>)("%s SSE run.completed event output is masked", async (_name, headers, url) => {
    const res = await app.inject({ method: "GET", url: url.replace("{id}", ids.run!), headers: await headers() });
    expect(res.statusCode).toBe(200);
    const line = res.body.split("\n").find((l) => l.startsWith("data: ") && l.includes("run.completed"));
    expect(line, res.body.slice(0, 300)).toBeTruthy();
    expectMasked((JSON.parse(line!.slice(6)) as { data: { output: unknown } }).data.output);
  });

  it("the stored row keeps the original output", async () => {
    const run = await repos.getRun(ids.run!);
    expect(run!.output_json).toEqual(OUTPUT);
  });

  it("static: no route returns run output_json unmasked", () => {
    const root = join(import.meta.dirname, "..", "apps", "api", "src");
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));
    const raw = files(root).flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => [f, i + 1, line] as const)).filter(([, , line]) => /:\s*\w+!?\.output_json\b/.test(line));
    expect(raw.map(([f, n]) => `${f.slice(root.length)}:${n}`)).toEqual([]);
  });
});
