import http from "node:http";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";

const port = 8091;
const issuer = `http://127.0.0.1:${port}`;
const audience = "forge";
const clientId = "forge-client";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
const publicPem = await exportSPKI(publicKey);

const idTokenFor = async (nonce?: string) => {
  const token = new SignJWT({
    sub: "admin-oidc-subject",
    email: "admin@forge.local",
    name: "Platform Admin",
    realm_access: { roles: ["admin"] },
    ...(nonce ? { nonce } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "oidc-test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  return token;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", issuer);
  const send = (body: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/.well-known/openid-configuration") {
    return send({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    });
  }
  if (url.pathname === "/jwks") {
    return send({ keys: [{ ...jwk, kid: "oidc-test-key", alg: "RS256", use: "sig" }] });
  }
  if (url.pathname === "/token") {
    const token = await idTokenFor();
    return send({ id_token: token, access_token: token, token_type: "Bearer", expires_in: 3600 });
  }
  res.writeHead(404).end();
});

await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

process.env.OIDC_ISSUER = issuer;
process.env.OIDC_CLIENT_ID = clientId;
process.env.OIDC_CLIENT_SECRET = "test-secret";
process.env.OIDC_AUDIENCE = audience;
process.env.OIDC_REDIRECT_URI = "http://127.0.0.1:3100/auth/oidc/callback";
process.env.SSO_MODE = "required";
process.env.SSO_TOKEN_VALIDATION_MODE = "oidc";
process.env.SSO_ROLE_MAPPING_REQUIRED = "true";
process.env.AGENT_CONNECTOR_ENABLED = "true";
process.env.AGENT_CONNECTOR_INBOUND_ENABLED = "true";
process.env.AGENT_CONNECTOR_LEGACY_FALLBACK_ENABLED = "false";
process.env.AGENT_CONNECTOR_ENVIRONMENT = "test";
process.env.AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64 = Buffer.from(publicPem).toString("base64");
process.env.CONNECTOR_PRINCIPAL_ISSUER = `${issuer}/connector`;
process.env.CONNECTOR_PRINCIPAL_AUDIENCE = "forge-connector";

const { buildOidcAuthorizeUrl, handleOidcCallback, verifyConnectorPrincipal, principalForConnector } = await import("@forge/identity");
const { repos } = await import("@forge/store");

try {
  const authorizeUrl = await buildOidcAuthorizeUrl("/agents");
  const state = new URL(authorizeUrl).searchParams.get("state");
  if (!state) throw new Error("auth URL missing state");
  const result = await handleOidcCallback("mock-code", state);
  if (result.principal.role !== "platform_admin") throw new Error(`unexpected role ${result.principal.role}`);
  console.log("✓ OIDC authorization URL + token exchange + role mapping");

  const existingConnectorUser = await repos.getUserByIdpSubject("connector-user");
  const connectorUserId = existingConnectorUser?.id ?? await repos.createUser({
    email: "connector-user@forge.local",
    username: "connector-user",
    displayName: "Connector User",
    role: "user",
    dataScope: "self",
    idpSubject: "connector-user",
  });
  const connectorToken = await new SignJWT({
    principalType: "user",
    subject: "connector-user",
    application: "forge-test",
    environment: "test",
    roles: [{ code: "user", name: "User" }],
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })
    .setProtectedHeader({ alg: "RS256", kid: "connector-test-key" })
    .setIssuer(`${issuer}/connector`)
    .setAudience("forge-connector")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  const principal = await verifyConnectorPrincipal(connectorToken);
  const mapped = await principalForConnector(principal);
  if (mapped.id !== connectorUserId) throw new Error("connector principal mapping failed");
  console.log("✓ Connector Principal signature + subject mapping");
  await repos.audit({ actorType: "system", action: "smoke.sso", resourceType: "system", resourceId: null });
} finally {
  server.close();
}
console.log("SSO SMOKE PASS");
process.exit(0);
