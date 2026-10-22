import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../apps/api/src/app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("buildApp (route-level smoke via inject)", () => {
  it("serves /healthz", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("rejects admin API without session with 401 in error format", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/agents" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toHaveProperty("code");
  });
});

describe("buildApp({ config }) override: connector verification without env vars", () => {
  const issuer = "forge-test-connector";
  const audience = "forge-test";
  let connectorApp: FastifyInstance;
  let privateKey: CryptoKey;
  let otherPrivateKey: CryptoKey;

  const sign = (key: CryptoKey, claims: Record<string, unknown>) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(key);
  const callAgents = (token: string) => connectorApp.inject({ method: "GET", url: "/integration/v1/agents", headers: { authorization: `Bearer ${token}` } });
  const baseClaims = { principalType: "user", application: "inject-test", environment: "test", roles: [] };

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey;
    otherPrivateKey = (await generateKeyPair("RS256")).privateKey;
    connectorApp = await buildApp({
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
    await connectorApp.ready();
  });

  afterAll(async () => {
    await connectorApp.close();
  });

  it("valid signature but subject not registered in Forge -> 403 CON-4706", async () => {
    const res = await callAgents(await sign(privateKey, { ...baseClaims, subject: `unregistered-${Date.now()}` }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CON-4706");
  });

  it("valid signature but wrong environment -> 401 CON-4705", async () => {
    const res = await callAgents(await sign(privateKey, { ...baseClaims, subject: "someone", environment: "prod" }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("CON-4705");
  });

  it("token signed by a different key is rejected (currently surfaces as 500 SYS-9001)", async () => {
    // jose's signature error is not a ForgeError, so the global error handler maps it to 500.
    // This pins current behavior; switching it to 401 is a separate, deliberate change.
    const res = await callAgents(await sign(otherPrivateKey, { ...baseClaims, subject: "someone" }));
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("SYS-9001");
  });
});
