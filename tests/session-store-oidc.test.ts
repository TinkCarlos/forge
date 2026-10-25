import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { config } from "@forge/core";
import { pendingOidcReturnTo, sha256Hex } from "@forge/identity";
import { one, pool, query } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { secondInstance, type SecondInstance } from "./helpers/second-instance.js";

// Session store (007): the OIDC login state (verifier, nonce, returnTo) lives in auth_oidc_states, keyed by SHA-256 of
// the state, 10 minutes, consumed once (SELECT ... FOR UPDATE + DELETE in one transaction). A local mock IdP serves
// discovery; its token endpoint answers 400, so a callback that got past the state check ends in SSO-1204, while a
// missing / used / expired state is SSO-1203.
let appA: FastifyInstance;
let b: SecondInstance;
let server: Server;
let issuer = "";
const OIDC_KEYS = ["OUTBOUND_ALLOWLIST", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] as const;
const saved: Record<string, unknown> = {};
const configure = (cfg: Record<string, unknown>, port: number) => {
  cfg.OUTBOUND_ALLOWLIST = `127.0.0.1:${port}`;
  cfg.OIDC_ISSUER = issuer;
  cfg.OIDC_CLIENT_ID = "forge-sess-test";
  cfg.OIDC_CLIENT_SECRET = "sess-test-secret";
};
const json = { accept: "application/json" };
const codeOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string } }).error.code;
const callback = (app: FastifyInstance, state: string) => app.inject({ method: "GET", url: `/auth/oidc/callback?code=c1&state=${encodeURIComponent(state)}`, headers: json });
const startLogin = async (app: FastifyInstance, returnTo = "/next/agents") => {
  const res = await app.inject({ method: "GET", url: `/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}` });
  expect(res.statusCode, res.body).toBe(302);
  const state = new URL(String(res.headers.location)).searchParams.get("state");
  expect(state).toBeTruthy();
  return state!;
};
const stateRow = (state: string) => one<{ state_hash: string; return_to: string; expires_at: Date; created_at: Date }>("SELECT * FROM auth_oidc_states WHERE state_hash = ?", [sha256Hex(state)]);

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    if (url.pathname === "/idp/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }),
      );
      return;
    }
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  issuer = `http://127.0.0.1:${port}/idp`;
  for (const key of OIDC_KEYS) saved[key] = (config as unknown as Record<string, unknown>)[key];
  appA = await buildApp({ logger: false });
  await appA.ready();
  b = await secondInstance();
  configure(config as unknown as Record<string, unknown>, port);
  configure(b.core.config as unknown as Record<string, unknown>, port);
});
beforeEach(async () => {
  await query("SELECT 1");
});
afterAll(async () => {
  for (const key of OIDC_KEYS) (config as unknown as Record<string, unknown>)[key] = saved[key];
  await appA?.close();
  await b?.close();
  await new Promise((resolve) => server.close(resolve));
});

describe("session store: OIDC state in auth_oidc_states", () => {
  it("SS-02: state issued by A is accepted by B's callback (gets past the state check to the token exchange), then consumed", async () => {
    const state = await startLogin(appA, "/next/runs?page=2");
    const row = await stateRow(state);
    expect(row?.return_to).toBe("/next/runs?page=2");
    expect(row?.state_hash).toBe(sha256Hex(state));
    expect(await query("SELECT state_hash FROM auth_oidc_states WHERE state_hash = ?", [state])).toHaveLength(0);
    const ttl = new Date(row!.expires_at).getTime() - new Date(row!.created_at).getTime();
    expect(ttl).toBe(10 * 60 * 1000);
    expect(await b.identity.pendingOidcReturnTo(state)).toBe("/next/runs?page=2");
    const first = await callback(b.app, state);
    expect(codeOf(first)).toBe("SSO-1204");
    expect(await stateRow(state)).toBeNull();
    expect(codeOf(await callback(appA, state))).toBe("SSO-1203");
  });

  it("SS-07: concurrent callbacks with the same state -> exactly one gets past the state, every other one SSO-1203", async () => {
    for (let round = 0; round < 6; round += 1) {
      // Issued on one instance, raced on the other (separate pool connections, so the race is decided in the database);
      // odd rounds also race across both instances.
      const issuer = round % 2 ? b.app : appA;
      const other = round % 2 ? appA : b.app;
      const state = await startLogin(issuer);
      const racers = round % 2 ? [other, other, issuer, other] : [other, other, other];
      const results = await Promise.all(racers.map((app) => callback(app, state)));
      const codes = results.map(codeOf);
      expect(codes.filter((code) => code === "SSO-1204")).toHaveLength(1);
      expect(codes.filter((code) => code === "SSO-1203")).toHaveLength(racers.length - 1);
      expect(await stateRow(state)).toBeNull();
    }
  });

  it("SS-08: an expired state -> SSO-1203; pendingOidcReturnTo does not consume a live state and ignores an expired one", async () => {
    const live = await startLogin(appA, "/next/agents");
    expect(await pendingOidcReturnTo(live)).toBe("/next/agents");
    expect(await b.identity.pendingOidcReturnTo(live)).toBe("/next/agents");
    expect(await stateRow(live)).not.toBeNull();
    expect(codeOf(await callback(b.app, live))).toBe("SSO-1204");

    const expired = await startLogin(b.app, "/next/agents");
    await pool.execute("UPDATE auth_oidc_states SET expires_at = ? WHERE state_hash = ?", [new Date(Date.now() - 1000), sha256Hex(expired)]);
    expect(await pendingOidcReturnTo(expired)).toBeNull();
    expect(codeOf(await callback(appA, expired))).toBe("SSO-1203");
  });

  it("SS-14 (state): an expired state row is rejected with no cleanup run, on both instances", async () => {
    const state = await startLogin(appA);
    await pool.execute("UPDATE auth_oidc_states SET expires_at = ? WHERE state_hash = ?", [new Date(Date.now() - 1), sha256Hex(state)]);
    expect(await stateRow(state)).not.toBeNull();
    expect(codeOf(await callback(b.app, state))).toBe("SSO-1203");
    expect(codeOf(await callback(appA, state))).toBe("SSO-1203");
    await pool.execute("DELETE FROM auth_oidc_states WHERE state_hash = ?", [sha256Hex(state)]);
  });

  it("return_to validation is unchanged: an unsafe returnTo is stored as the /next/ fallback", async () => {
    const state = await startLogin(appA, "//evil.example/x");
    expect((await stateRow(state))?.return_to).toBe("/next/");
    await pool.execute("DELETE FROM auth_oidc_states WHERE state_hash = ?", [sha256Hex(state)]);
  });
});
