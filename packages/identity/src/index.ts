import { randomBytes, createHash } from "node:crypto";
import { createRemoteJWKSet, importSPKI, jwtVerify, type JWTPayload } from "jose";
import {
  config,
  defaultDataScope,
  errors,
  ForgeError,
  hashApiKey,
  safeEqual,
  signSession,
  verifyPassword,
  type DataScope,
  type Principal,
  type Config,
  type Role,
} from "@forge/core";
import { repos, parseJsonValue, type UserRow } from "@forge/store";

export interface Session {
  token: string;
  principal: Principal;
  expiresAt: number;
  csrfToken: string;
}

const sessions = new Map<string, Session>();
const oidcStates = new Map<string, { verifier: string; nonce: string; returnTo: string; expiresAt: number }>();

export function toPrincipal(user: UserRow): Principal {
  return {
    type: "user",
    id: user.id,
    name: user.display_name,
    role: user.role as Role,
    orgUnitId: user.org_unit_id,
    dataScope: user.data_scope as DataScope,
  };
}

export function createSession(principal: Principal): Session {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const session: Session = {
    token,
    principal,
    csrfToken,
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  };
  sessions.set(token, session);
  return session;
}

export function getSession(token: string | undefined): Session | null {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

export function sessionCookieValue(session: Session): string {
  return `${session.token}.${signSession(session.token, config.SESSION_SECRET)}`;
}

export function readSignedSessionCookie(value: string | undefined): Session | null {
  if (!value) return null;
  const index = value.lastIndexOf(".");
  if (index < 1) return null;
  const token = value.slice(0, index);
  const signature = value.slice(index + 1);
  if (!safeEqual(signature, signSession(token, config.SESSION_SECRET))) return null;
  return getSession(token);
}

export async function loginLocal(email: string, password: string): Promise<Principal> {
  if (!config.ALLOW_LOCAL_LOGIN) throw errors.forbidden("本地登录已关闭，请使用统一 SSO");
  const user = await repos.getUserByEmail(email);
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    throw errors.unauthorized("邮箱或密码错误");
  }
  return toPrincipal(user);
}

export async function authenticateApiKey(rawKey: string): Promise<Principal> {
  if (!rawKey.startsWith("fsk_")) throw errors.unauthorized("API Key 格式不正确");
  const prefix = rawKey.slice(0, 16);
  const keyRow = await repos.findApiKeyByPrefix(prefix);
  if (!keyRow) throw errors.unauthorized("API Key 无效");
  const expected = String(keyRow.key_hash);
  const actual = hashApiKey(rawKey, config.API_KEY_PEPPER);
  if (!safeEqual(expected, actual)) throw errors.unauthorized("API Key 无效");
  if (keyRow.expires_at && new Date(keyRow.expires_at as string).getTime() < Date.now()) {
    throw errors.unauthorized("API Key 已过期");
  }
  await repos.touchApiKey(String(keyRow.id));
  return {
    type: "app",
    id: String(keyRow.app_id),
    name: `app:${String(keyRow.app_id)}`,
    role: "user",
    orgUnitId: null,
    dataScope: "app",
    appId: String(keyRow.app_id),
    scopes: parseJsonValue<string[]>(keyRow.scopes_json, []),
  };
}

// ---------- OIDC ----------

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

const discoveryCache = new Map<string, Discovery>();

export function oidcConfigured(): boolean {
  return Boolean(config.OIDC_ISSUER && config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET);
}

async function discovery(): Promise<Discovery> {
  if (!config.OIDC_ISSUER) throw new ForgeError("SSO-1201", "SSO 尚未配置", 503);
  const cached = discoveryCache.get(config.OIDC_ISSUER);
  if (cached) return cached;
  const response = await fetch(`${config.OIDC_ISSUER.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!response.ok) throw new ForgeError("SSO-1202", "无法获取 OIDC discovery", 502);
  const doc = (await response.json()) as Discovery;
  discoveryCache.set(config.OIDC_ISSUER, doc);
  return doc;
}

export async function buildOidcAuthorizeUrl(returnTo = "/"): Promise<string> {
  const doc = await discovery();
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  oidcStates.set(state, { verifier, nonce, returnTo, expiresAt: Date.now() + 10 * 60 * 1000 });
  const redirectUri = config.OIDC_REDIRECT_URI ?? `${config.FORGE_PUBLIC_URL}/auth/oidc/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.OIDC_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    scope: config.OIDC_SCOPES,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${doc.authorization_endpoint}?${params.toString()}`;
}

export async function handleOidcCallback(code: string, state: string): Promise<{ principal: Principal; returnTo: string }> {
  const saved = oidcStates.get(state);
  if (!saved || saved.expiresAt < Date.now()) throw new ForgeError("SSO-1203", "登录状态已过期，请重试", 400);
  oidcStates.delete(state);
  const doc = await discovery();
  const redirectUri = config.OIDC_REDIRECT_URI ?? `${config.FORGE_PUBLIC_URL}/auth/oidc/callback`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.OIDC_CLIENT_ID ?? "",
    code_verifier: saved.verifier,
  });
  if (config.OIDC_CLIENT_SECRET) body.set("client_secret", config.OIDC_CLIENT_SECRET);
  const tokenResponse = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenResponse.ok) throw new ForgeError("SSO-1204", "OIDC 令牌交换失败", 401);
  const tokens = (await tokenResponse.json()) as { id_token?: string; access_token?: string };
  if (!tokens.id_token) throw new ForgeError("SSO-1205", "OIDC 未返回 id_token", 401);
  const jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: doc.issuer,
    audience: config.OIDC_AUDIENCE ?? config.OIDC_CLIENT_ID,
  });
  if (payload.nonce && payload.nonce !== saved.nonce) throw new ForgeError("SSO-1206", "nonce 校验失败", 401);

  let principalPayload: JWTPayload = payload;
  if (config.SSO_TOKEN_VALIDATION_MODE === "agent-principal" || config.SSO_TOKEN_VALIDATION_MODE === "both") {
    if (!tokens.access_token) throw new ForgeError("SSO-1207", "未返回 access_token", 401);
    const publicKey = await connectorPublicKey();
    const verified = await jwtVerify(tokens.access_token, publicKey, {
      issuer: config.CONNECTOR_PRINCIPAL_ISSUER ?? doc.issuer,
      audience: config.CONNECTOR_PRINCIPAL_AUDIENCE ?? config.OIDC_AUDIENCE ?? config.OIDC_CLIENT_ID,
    });
    if (payload.sub && verified.payload.sub && payload.sub !== verified.payload.sub) {
      throw new ForgeError("SSO-1208", "access_token 与 id_token 主体不一致", 401);
    }
    principalPayload = { ...payload, ...verified.payload };
  }

  const nonceOk = !principalPayload.nonce || principalPayload.nonce === saved.nonce;
  if (!nonceOk) throw new ForgeError("SSO-1206", "nonce 校验失败", 401);
  const email = typeof principalPayload.email === "string" ? principalPayload.email : undefined;
  const subject = String(principalPayload.sub ?? principalPayload.subject ?? "");
  if (!subject) throw new ForgeError("SSO-1209", "OIDC 主体缺失", 401);
  const displayName = String(principalPayload.name ?? principalPayload.preferred_username ?? email ?? subject);
  const roles = extractRoles(principalPayload);
  const localRole = await mapRoles(roles);
  if (!localRole) throw new ForgeError("SSO-1201", "当前账号没有 Forge 访问角色，请联系管理员", 403);

  let user = await repos.getUserByIdpSubject(subject);
  if (!user && email) user = await repos.getUserByEmail(email);
  if (!user) {
    if (!email) throw new ForgeError("SSO-1210", "用户缺少邮箱，无法创建本地账号", 403);
    const userId = await repos.createUser({
      email,
      username: String(principalPayload.preferred_username ?? subject).slice(0, 64),
      displayName,
      role: localRole,
      dataScope: defaultDataScope(localRole),
      orgUnitId: null,
      idpSubject: subject,
    });
    user = await repos.getUserById(userId);
  } else {
    await repos.updateUser(user.id, { role: localRole, dataScope: defaultDataScope(localRole), displayName });
    if (!user.idp_subject) await repos.setIdpSubject(user.id, subject);
  }
  if (!user) throw new ForgeError("SSO-1211", "用户创建失败", 500);
  return { principal: toPrincipal(user), returnTo: saved.returnTo };
}

function extractRoles(payload: JWTPayload): Array<{ code: string; name: string }> {
  const result: Array<{ code: string; name: string }> = [];
  const realm = payload.realm_access as { roles?: unknown } | undefined;
  if (Array.isArray(realm?.roles)) {
    for (const role of realm.roles) if (typeof role === "string") result.push({ code: role, name: "" });
  }
  if (Array.isArray(payload.roles)) {
    for (const role of payload.roles) {
      if (typeof role === "string") result.push({ code: role, name: "" });
      else if (role && typeof role === "object") {
        const object = role as Record<string, unknown>;
        if (typeof object.code === "string") result.push({ code: object.code, name: typeof object.name === "string" ? object.name : object.code });
      }
    }
  }
  if (typeof payload.role === "string") result.push({ code: payload.role, name: "" });
  return result;
}

async function mapRoles(roles: Array<{ code: string; name: string }>): Promise<Role | null> {
  const mappings = await repos.listRoleMappings();
  const priority: Role[] = ["platform_admin", "org_admin", "builder", "operator", "auditor", "user"];
  let best: Role | null = null;
  for (const role of roles) {
    const mapping = mappings.find((row) => {
      const codeMatch = String(row.agent_role_code) === role.code;
      const nameMatch = !config.SSO_ROLE_MAPPING_REQUIRED || !row.agent_role_name || !role.name || String(row.agent_role_name) === role.name;
      return codeMatch && nameMatch;
    });
    if (!mapping) continue;
    const local = String(mapping.local_role) as Role;
    if (!best || priority.indexOf(local) < priority.indexOf(best)) best = local;
  }
  if (!best && config.SSO_ROLE_MAPPING_REQUIRED) return null;
  return best ?? "user";
}

/** Config fields read by connector principal verification; overridable per app (see buildApp) for tests. */
export type ConnectorConfig = Pick<
  Config,
  | "AGENT_CONNECTOR_ENABLED"
  | "AGENT_CONNECTOR_INBOUND_ENABLED"
  | "AGENT_CONNECTOR_LEGACY_FALLBACK_ENABLED"
  | "AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64"
  | "AGENT_CONNECTOR_ENVIRONMENT"
  | "CONNECTOR_PRINCIPAL_ISSUER"
  | "CONNECTOR_PRINCIPAL_AUDIENCE"
>;

async function connectorPublicKey(cfg: ConnectorConfig = config): Promise<CryptoKey> {
  if (!cfg.AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64) throw new ForgeError("CON-4702", "Connector 验签公钥未配置", 503);
  const pem = Buffer.from(cfg.AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64, "base64").toString("utf8");
  return importSPKI(pem, "RS256");
}

export interface ConnectorPrincipal {
  principalType: "user" | "service" | "delegated_user";
  subject: string;
  application: string;
  environment: string;
  roles: Array<{ code: string; name: string }>;
  scopes?: string[];
  enterpriseUserId?: string | null;
  username?: string | null;
  displayName?: string | null;
}

export async function verifyConnectorPrincipal(token: string, cfg: ConnectorConfig = config): Promise<ConnectorPrincipal> {
  if (!cfg.AGENT_CONNECTOR_ENABLED || !cfg.AGENT_CONNECTOR_INBOUND_ENABLED) {
    throw new ForgeError("CON-4703", "Connector 入站未启用", 503);
  }
  if (cfg.AGENT_CONNECTOR_LEGACY_FALLBACK_ENABLED) {
    throw new ForgeError("CON-4704", "Connector legacy fallback 必须关闭", 503);
  }
  const publicKey = await connectorPublicKey(cfg);
  let rawPayload: JWTPayload;
  try {
    ({ payload: rawPayload } = await jwtVerify(token, publicKey, {
      issuer: cfg.CONNECTOR_PRINCIPAL_ISSUER,
      audience: cfg.CONNECTOR_PRINCIPAL_AUDIENCE,
    }));
  } catch {
    // Bad signature, expired, wrong issuer/audience or malformed token: a client error, not a 500.
    throw new ForgeError("CON-4707", "Connector 令牌无效或已过期", 401);
  }
  const payload = rawPayload as unknown as ConnectorPrincipal;
  if (!payload.subject || !payload.principalType) throw new ForgeError("CON-4701", "Principal 缺少主体", 401);
  if (payload.environment !== cfg.AGENT_CONNECTOR_ENVIRONMENT) throw new ForgeError("CON-4705", "运行环境不匹配", 401);
  return payload;
}

export async function principalForConnector(payload: ConnectorPrincipal): Promise<Principal> {
  const user = await repos.getUserByIdpSubject(payload.subject);
  if (!user) throw new ForgeError("CON-4706", "Connector 主体未在 Forge 登记", 403);
  return toPrincipal(user);
}
