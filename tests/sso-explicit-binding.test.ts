import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { config, hashPassword } from "@forge/core";
import { execute, repos } from "@forge/store";
import { buildOidcAuthorizeUrl, handleOidcCallback } from "@forge/identity";

let token = "";
let accessToken = "";
const issuer = "https://identity.forge.test";
const suffix = randomBytes(5).toString("hex");
const subject = `SSO-Subject-${suffix}`;
const email = `sso-binding-${suffix}@forge.local`;
let id = "";
const saved = { OIDC_ISSUER: config.OIDC_ISSUER, OIDC_CLIENT_ID: config.OIDC_CLIENT_ID, OIDC_CLIENT_SECRET: config.OIDC_CLIENT_SECRET, OIDC_AUDIENCE: config.OIDC_AUDIENCE, SSO_ROLE_MAPPING_REQUIRED: config.SSO_ROLE_MAPPING_REQUIRED, SSO_TOKEN_VALIDATION_MODE: config.SSO_TOKEN_VALIDATION_MODE, AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64: config.AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64, CONNECTOR_PRINCIPAL_ISSUER: config.CONNECTOR_PRINCIPAL_ISSUER, CONNECTOR_PRINCIPAL_AUDIENCE: config.CONNECTOR_PRINCIPAL_AUDIENCE };
const keys = await generateKeyPair("RS256");
const jwk = await exportJWK(keys.publicKey);
vi.mock("@forge/core", async importOriginal => {
  const actual = await importOriginal<typeof import("@forge/core")>();
  return { ...actual, safeFetch: vi.fn(async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    const payload = path.includes("openid-configuration") ? { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` } : path === "/jwks" ? { keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] } : { id_token: token, ...(accessToken ? { access_token: accessToken } : {}) };
    return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  }) };
});
beforeAll(async () => {
  Object.assign(config, { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "forge", OIDC_CLIENT_SECRET: "mock-secret", OIDC_AUDIENCE: "forge", SSO_ROLE_MAPPING_REQUIRED: false });
  id = await repos.createUser({ email, username: `local-binding-${suffix}`, displayName: "Local name", passwordHash: hashPassword("Local!2026"), role: "builder", dataScope: "self" });
});
afterAll(async () => { Object.assign(config, saved); vi.restoreAllMocks(); if (id) { await execute("DELETE FROM audit_logs WHERE resource_id = ?", [id]); await execute("DELETE FROM users WHERE id = ?", [id]); } });
async function callback(sub = subject, tokenIssuer = issuer, includeNonce = true) {
  const url = new URL(await buildOidcAuthorizeUrl());
  token = await new SignJWT({ sub, email, name: "External renamed", roles: ["user"], ...(includeNonce ? { nonce: url.searchParams.get("nonce") } : {}) }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(tokenIssuer).setAudience("forge").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
  return handleOidcCallback("mock-code", url.searchParams.get("state")!);
}
it("same email never binds automatically; explicit issuer+subject binding preserves local grants", async () => {
  await expect(callback()).rejects.toMatchObject({ code: "SSO-1213" });
  let row = (await repos.getUserById(id))!;
  expect(row.idp_subject).toBeNull();
  await repos.bindUserIdentity(id, subject, issuer, { expectedRevision: row.revision });
  const first = await callback();
  expect(first.principal).toMatchObject({ id, role: "builder", dataScope: "self", name: "Local name" });
  await repos.updateUser(id, { role: "auditor", dataScope: "all" }, { expectedRevision: "system" });
  expect((await callback()).principal).toMatchObject({ id, role: "auditor", dataScope: "all", name: "Local name" });
  row = (await repos.getUserById(id))!;
  expect(row.password_hash).toMatch(/^scrypt\$/);
  await expect(callback(subject.toLowerCase())).rejects.toMatchObject({ code: "SSO-1213" });
  expect(await repos.getUserByIdpSubject(subject.toLowerCase(), issuer)).toBeNull();
  expect(await repos.getUserByIdpSubject(subject, `${issuer}/other`)).toBeNull();
  await repos.bindUserIdentity(id, subject, `${issuer}/old`, { expectedRevision: row.revision });
  await expect(callback()).rejects.toMatchObject({ code: "SSO-1213" });
  await repos.bindUserIdentity(id, subject, issuer, { expectedRevision: "system" });
  await expect(callback(subject, issuer, false)).rejects.toMatchObject({ code: "SSO-1206" });
  await repos.updateUser(id, { status: "disabled" }, { expectedRevision: "system" });
  await expect(callback()).rejects.toMatchObject({ code: "AUTH-1001" });
  await repos.updateUser(id, { status: "deleted" }, { expectedRevision: "system" });
  await expect(callback()).rejects.toMatchObject({ code: "AUTH-1001" });
});

it("rejects missing ID sub and every conflicting Access Token subject representation", async () => {
  Object.assign(config, { SSO_TOKEN_VALIDATION_MODE: "both", AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64: Buffer.from(await exportSPKI(keys.publicKey)).toString("base64"), CONNECTOR_PRINCIPAL_ISSUER: issuer, CONNECTOR_PRINCIPAL_AUDIENCE: "forge" });
  for (const [idSub, accessClaims, code] of [[undefined, { sub: subject }, "SSO-1209"], [subject, { subject: "another-user" }, "SSO-1208"], [subject, { sub: subject, subject: "another-user" }, "SSO-1208"], [subject, {}, "SSO-1208"]] as const) {
    const url = new URL(await buildOidcAuthorizeUrl());
    token = await new SignJWT({ ...(idSub === undefined ? {} : { sub: idSub }), nonce: url.searchParams.get("nonce"), email }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(issuer).setAudience("forge").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
    accessToken = await new SignJWT({ ...accessClaims, roles: ["admin"] }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(issuer).setAudience("forge").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
    await expect(handleOidcCallback("mock", url.searchParams.get("state")!)).rejects.toMatchObject({ code });
  }
});
