import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { createSession, destroySession, getSession, loadActivePrincipal, sessionCookieValue, toPrincipal, type Session } from "@forge/identity";
import { execute, pool, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";

// S-45 / OPS-024: a database error while resolving an identity is not "user unusable". loadActivePrincipal throws,
// session auth / connector / local login answer 503 SYS-9003, and the session is kept so the same cookie works again.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const PASSWORD = `pw-${suffix}`;
const issuer = "forge-outage";
const audience = "forge-outage";
let app: FastifyInstance;
let connectorApp: FastifyInstance;
let privateKey: CryptoKey;
let userId = "";
let session: Session;
let headers: Record<string, string> = {};
const email = `it-out-${suffix}@forge.local`;

const failDb = () => vi.spyOn(pool, "query").mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 10.9.9.9:3306"), { code: "ECONNREFUSED" }));
const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string } }).error;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
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
  const { hashPassword } = await import("@forge/core");
  userId = await repos.createUser({ email, username: `it-out-${suffix}`, displayName: "IT outage", role: "org_admin", dataScope: "org", orgUnitId: ROOT, passwordHash: hashPassword(PASSWORD), idpSubject: `it-out-sub-${suffix}` });
  session = createSession(toPrincipal((await repos.getUserById(userId))!));
  headers = { cookie: `forge_session=${sessionCookieValue(session)}`, "x-csrf-token": session.csrfToken };
});

afterAll(async () => {
  vi.restoreAllMocks();
  destroySession(session?.token);
  await execute("DELETE FROM audit_logs WHERE actor_id = ?", [userId]);
  await execute("DELETE FROM users WHERE id = ?", [userId]);
  await app?.close();
  await connectorApp?.close();
});

describe("identity lookups when the database fails", () => {
  it("loadActivePrincipal throws (503 SYS-9003) instead of returning null", async () => {
    const spy = failDb();
    try {
      await expect(loadActivePrincipal(userId)).rejects.toMatchObject({ code: "SYS-9003", httpStatus: 503 });
    } finally {
      spy.mockRestore();
    }
  });

  it("session auth -> 503 SYS-9003, session kept, same cookie works after recovery", async () => {
    const spy = failDb();
    let res: LightMyRequestResponse;
    try {
      res = await app.inject({ method: "GET", url: "/admin/api/users", headers });
    } finally {
      spy.mockRestore();
    }
    expect(res.statusCode).toBe(503);
    expect(errorOf(res).code).toBe("SYS-9003");
    expect(res.body).not.toContain("10.9.9.9");
    expect(getSession(session.token)).not.toBeNull();
    expect((await app.inject({ method: "GET", url: "/admin/api/users", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/session", headers })).statusCode).toBe(200);
  });

  it("connector principal -> 503 (not 403 CON-4706), works after recovery", async () => {
    const token = await new SignJWT({ principalType: "user", application: "outage", environment: "test", roles: [], subject: `it-out-sub-${suffix}` })
      .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const call = () => connectorApp.inject({ method: "GET", url: "/integration/v1/agents", headers: { authorization: `Bearer ${token}` } });
    const spy = failDb();
    let res: LightMyRequestResponse;
    try {
      res = await call();
    } finally {
      spy.mockRestore();
    }
    expect(res.statusCode).toBe(503);
    expect(errorOf(res).code).toBe("SYS-9003");
    expect((await call()).statusCode).toBe(200);
  });

  it("local login -> 503 (not 401 wrong password), works after recovery", async () => {
    const login = () => app.inject({ method: "POST", url: "/auth/local/login", payload: { email, password: PASSWORD } });
    const spy = failDb();
    let res: LightMyRequestResponse;
    try {
      res = await login();
    } finally {
      spy.mockRestore();
    }
    expect(res.statusCode).toBe(503);
    expect(errorOf(res).code).toBe("SYS-9003");
    const ok = await login();
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === "forge_session");
    if (cookie) await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: `forge_session=${cookie.value}` } });
  });
});
