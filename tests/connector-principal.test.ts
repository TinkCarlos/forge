import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { execute, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// Connector principal (/integration/v1): a disabled/deleted user, or a user whose department (or any parent department)
// is disabled or gone, gets exactly the same 403 CON-4706 as an unregistered subject.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const id26 = (tag: string): string => `${tag}${randomBytes(16).toString("hex").toUpperCase()}`.slice(0, 26);
const ORG_OK = id26("ITCO");
const ORG_OFF = id26("ITCF");
const ORG_PARENT_OFF = id26("ITCP");
const ORG_CHILD = id26("ITCC");
const MISSING_ORG = id26("ITCM");
const issuer = "forge-conn-principal";
const audience = "forge-conn";
const users: string[] = [];
let app: FastifyInstance;
let privateKey: CryptoKey;

const sub = (tag: string) => `it-cp-${tag}-${suffix}`;
async function makeUser(tag: string, orgUnitId: string | null, status = "active"): Promise<string> {
  const id = await repos.createUser({ email: `${sub(tag)}@forge.local`, username: sub(tag), displayName: tag, role: "user", dataScope: "self", orgUnitId, idpSubject: sub(tag) });
  if (status !== "active") await repos.updateUser(id, { status });
  users.push(id);
  return id;
}
async function call(subject: string): Promise<LightMyRequestResponse> {
  const token = await new SignJWT({ principalType: "user", application: "cp-test", environment: "test", roles: [], subject })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  return app.inject({ method: "GET", url: "/integration/v1/agents", headers: { authorization: `Bearer ${token}` } });
}
const shape = (res: LightMyRequestResponse) => {
  const { requestId: _ignored, ...error } = (res.json() as { error: Record<string, unknown> }).error;
  return { status: res.statusCode, error };
};

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  app = await buildApp({
    logger: false,
    config: {
      AGENT_CONNECTOR_ENABLED: true,
      AGENT_CONNECTOR_INBOUND_ENABLED: true,
      AGENT_CONNECTOR_LEGACY_FALLBACK_ENABLED: false,
      AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64: Buffer.from(await exportSPKI(pair.publicKey)).toString("base64"),
      AGENT_CONNECTOR_ENVIRONMENT: "test",
      CONNECTOR_PRINCIPAL_ISSUER: issuer,
      CONNECTOR_PRINCIPAL_AUDIENCE: audience,
    },
  });
  await app.ready();
  const org = (id: string, parent: string, path: string, status = "active") =>
    execute("INSERT INTO org_units (id, parent_id, `key`, name, path, status) VALUES (?, ?, ?, ?, ?, ?)", [id, parent, `it-cp-${id.slice(0, 5)}-${suffix}`, "IT cp", path, status]);
  await org(ORG_OK, ROOT, `/it-cp-ok-${suffix}/`);
  await org(ORG_OFF, ROOT, `/it-cp-off-${suffix}/`, "disabled");
  await org(ORG_PARENT_OFF, ROOT, `/it-cp-pof-${suffix}/`, "disabled");
  await org(ORG_CHILD, ORG_PARENT_OFF, `/it-cp-pof-${suffix}/it-cp-ch-${suffix}/`);
  await makeUser("ok", ORG_OK);
  await makeUser("noorg", null);
  await makeUser("disabled", ORG_OK, "disabled");
  await makeUser("deleted", ORG_OK, "deleted");
  await makeUser("orgoff", ORG_OFF);
  await makeUser("parentoff", ORG_CHILD);
  await makeUser("orggone", MISSING_ORG);
  const gone = await makeUser("rowgone", ORG_OK);
  await execute("DELETE FROM users WHERE id = ?", [gone]);
});

afterAll(async () => {
  for (const id of users) await execute("DELETE FROM users WHERE id = ?", [id]);
  await execute("DELETE FROM org_units WHERE id IN (?, ?, ?, ?)", [ORG_CHILD, ORG_OK, ORG_OFF, ORG_PARENT_OFF]);
  await app?.close();
});

describe("principalForConnector rejects inactive users and departments like unregistered subjects", () => {
  it("active user in an active department -> 200; user without department -> 200", async () => {
    expect((await call(sub("ok"))).statusCode).toBe(200);
    expect((await call(sub("noorg"))).statusCode).toBe(200);
  });

  it.each(["disabled", "deleted", "rowgone", "orgoff", "parentoff", "orggone"])("%s -> identical 403 CON-4706", async (tag) => {
    const unregistered = shape(await call(`it-cp-nobody-${suffix}`));
    expect(unregistered.status).toBe(403);
    expect(unregistered.error.code).toBe("CON-4706");
    expect(shape(await call(sub(tag)))).toEqual(unregistered);
  });
});
