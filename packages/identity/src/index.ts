import { randomBytes, createHash } from "node:crypto";
import { createLocalJWKSet, importSPKI, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import {
  config,
  defaultDataScope,
  errors,
  ForgeError,
  hashApiKey,
  hashPassword,
  OUTBOUND_BLOCKED_CODE,
  safeEqual,
  safeFetch,
  signSession,
  verifyPassword,
  type DataScope,
  type Principal,
  type Config,
  type Role,
} from "@forge/core";
import { repos, parseJsonValue, type UserRow } from "@forge/store";

/** What the server keeps per session: only the user id (plus CSRF token and expiry), never a principal snapshot. */
export interface StoredSession {
  token: string;
  userId: string;
  expiresAt: number;
  csrfToken: string;
}

/** A stored session resolved for the current request: `principal` is re-read from the database (loadActivePrincipal). */
export interface Session extends StoredSession {
  principal: Principal;
}


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

/**
 * Current principal of a user, read fresh from the database (one query, see repos.getActiveUserById): role, department and
 * data scope as they are now. null when the user does not exist, is not active (disabled/deleted), or its department is
 * missing or it or any parent department is not active. Shared by session authentication and the Connector principal.
 */
export async function loadActivePrincipal(userId: string): Promise<Principal | null> {
  const user = await identityLookup(() => repos.getActiveUserById(userId));
  return user ? toPrincipal(user) : null;
}

/**
 * Runs an identity database lookup. A database failure (connection lost, timeout, any error) is never treated as
 * "user unusable": it becomes 503 SYS-9003 so callers do not log the user out or answer 401/403. The cause is not exposed.
 */
async function identityLookup<T>(lookup: () => Promise<T>): Promise<T> {
  try {
    return await lookup();
  } catch {
    throw errors.unavailable("身份校验暂时不可用，请稍后重试");
  }
}

/** SHA-256 hex: the session store keeps only this digest of the cookie token (and of the OIDC state). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** last_seen_at is refreshed at most once per this interval (no sliding expiry: expires_at never moves). */
export const SESSION_LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Stores only `principal.id` (plus CSRF token and absolute expiry) in auth_sessions, keyed by the SHA-256 of the token.
 * The returned session carries the given principal for the login response. A database failure is 503 SYS-9003.
 */
export async function createSession(principal: Principal): Promise<Session> {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const now = Date.now();
  const stored: StoredSession = {
    token,
    userId: principal.id,
    csrfToken,
    expiresAt: now + config.SESSION_TTL_SECONDS * 1000, // N-01 (default 8h), absolute
  };
  await identityLookup(() =>
    repos.createAuthSession({ tokenHash: sha256Hex(token), userId: principal.id, csrfToken, now: new Date(now), expiresAt: new Date(stored.expiresAt) }),
  );
  return { ...stored, principal };
}

/** Live stored session for a token: expires_at > now is part of the query, so expiry holds without any cleanup run. */
export async function getSession(token: string | undefined): Promise<StoredSession | null> {
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const now = new Date();
  return identityLookup(async () => {
    const row = await repos.getAuthSession(tokenHash, now);
    if (!row) {
      await repos.deleteExpiredAuthSession(tokenHash, now);
      return null;
    }
    if (new Date(row.last_seen_at).getTime() < now.getTime() - SESSION_LAST_SEEN_THROTTLE_MS) {
      await repos.touchAuthSession(tokenHash, now, new Date(now.getTime() - SESSION_LAST_SEEN_THROTTLE_MS));
    }
    return { token, userId: row.user_id, csrfToken: row.csrf_token, expiresAt: new Date(row.expires_at).getTime() };
  });
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (token) await identityLookup(() => repos.deleteAuthSession(sha256Hex(token)));
}

export function sessionCookieValue(session: Session): string {
  return `${session.token}.${signSession(session.token, config.SESSION_SECRET)}`;
}

/**
 * Signature check first (no database access for a missing, malformed or tampered cookie), then the stored session
 * lookup (CSRF check, logout). No principal re-read here.
 */
export async function readStoredSessionCookie(value: string | undefined): Promise<StoredSession | null> {
  if (!value) return null;
  const index = value.lastIndexOf(".");
  if (index < 1) return null;
  const token = value.slice(0, index);
  const signature = value.slice(index + 1);
  if (!safeEqual(signature, signSession(token, config.SESSION_SECRET))) return null;
  return getSession(token);
}

/**
 * Resolves the session cookie for this request: the stored session plus the principal re-read by loadActivePrincipal.
 * When the user is no longer usable the stored session is destroyed and null is returned (callers answer 401 AUTH-1001).
 */
export async function readSignedSessionCookie(value: string | undefined): Promise<Session | null> {
  return sessionWithPrincipal(await readStoredSessionCookie(value));
}

/** The principal half of readSignedSessionCookie, for callers that already hold the stored session of this request. */
export async function sessionWithPrincipal(stored: StoredSession | null): Promise<Session | null> {
  if (!stored) return null;
  const principal = await loadActivePrincipal(stored.userId);
  if (!principal) {
    await destroySession(stored.token);
    return null;
  }
  return { ...stored, principal };
}

/** Well-formed scrypt hash of a random secret, made once on first use; only ever compared against, never matched. */
let dummyPasswordHash: string | null = null;
const SCRYPT_HASH = /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/;

/**
 * S-32: exactly one scrypt verification per login attempt whatever the account state, so response time does not reveal
 * an unknown email, an SSO-only user (no password_hash), a malformed stored hash, or a disabled user (getUserByEmail
 * returns active users only). Without a usable hash the dummy is checked and the result is always false.
 */
function checkPassword(password: string, stored: string | null | undefined): boolean {
  const usable = typeof stored === "string" && SCRYPT_HASH.test(stored);
  dummyPasswordHash ??= hashPassword(randomBytes(32).toString("hex"));
  const matches = verifyPassword(password, usable ? stored : dummyPasswordHash);
  return usable && matches;
}

export async function loginLocal(email: string, password: string): Promise<Principal> {
  if (!config.ALLOW_LOCAL_LOGIN) throw errors.forbidden("本地登录已关闭，请使用统一 SSO");
  const user = await identityLookup(() => repos.getUserByEmail(email));
  if (!checkPassword(password, user?.password_hash)) {
    throw errors.unauthorized("邮箱或密码错误");
  }
  if (!user) throw errors.unauthorized("邮箱或密码错误"); // unreachable (checkPassword is false without a user); narrows the type
  // A user whose department chain is disabled cannot log in either (same answer as a wrong password).
  const principal = await loadActivePrincipal(user.id);
  if (!principal) throw errors.unauthorized("邮箱或密码错误");
  return principal;
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

/**
 * OIDC fetch (discovery, token, JWKS): a target refused by the outbound guard is an upstream (IdP) problem -> 502 HTP-4003
 * for JSON callers. The browser entry points (/auth/oidc/login, /auth/oidc/callback) turn it into a redirect (AD).
 */
async function oidcFetch(url: string, init?: Parameters<typeof safeFetch>[1]): Promise<Response> {
  try {
    return await safeFetch(url, init);
  } catch (error) {
    if (error instanceof ForgeError && error.code === OUTBOUND_BLOCKED_CODE) throw new ForgeError(OUTBOUND_BLOCKED_CODE, error.message, 502, undefined, false);
    throw error;
  }
}

/** OIDC login state lifetime (auth_oidc_states.expires_at). */
export const OIDC_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The returnTo saved with a pending OIDC state (without consuming it), so a failed callback can keep it. Best effort:
 * a store failure gives null here (the callback itself then answers 503 SYS-9003).
 */
export async function pendingOidcReturnTo(state: string): Promise<string | null> {
  try {
    return await repos.peekOidcStateReturnTo(sha256Hex(state), new Date());
  } catch {
    return null;
  }
}

async function discovery(): Promise<Discovery> {
  if (!config.OIDC_ISSUER) throw new ForgeError("SSO-1201", "SSO 尚未配置", 503);
  const cached = discoveryCache.get(config.OIDC_ISSUER);
  if (cached) return cached;
  // Outbound guard (S-46): issuer, token endpoint and JWKS all go through safeFetch.
  const response = await oidcFetch(`${config.OIDC_ISSUER.replace(/\/$/, "")}/.well-known/openid-configuration`);
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
  const now = Date.now();
  await identityLookup(() =>
    repos.createOidcState({ stateHash: sha256Hex(state), verifier, nonce, returnTo, now: new Date(now), expiresAt: new Date(now + OIDC_STATE_TTL_MS) }),
  );
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
  // One-time, cross-instance consumption before the token exchange (a replay or a concurrent twin gets SSO-1203).
  const row = await identityLookup(() => repos.consumeOidcState(sha256Hex(state), new Date()));
  if (!row) throw new ForgeError("SSO-1203", "登录状态已过期，请重试", 400);
  const saved = { verifier: row.verifier, nonce: row.nonce, returnTo: row.return_to };
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
  const tokenResponse = await oidcFetch(doc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenResponse.ok) throw new ForgeError("SSO-1204", "OIDC 令牌交换失败", 401);
  const tokens = (await tokenResponse.json()) as { id_token?: string; access_token?: string };
  if (!tokens.id_token) throw new ForgeError("SSO-1205", "OIDC 未返回 id_token", 401);
  const jwksResponse = await oidcFetch(doc.jwks_uri);
  if (!jwksResponse.ok) throw new ForgeError("SSO-1202", "无法获取 OIDC JWKS", 502);
  const jwks = createLocalJWKSet((await jwksResponse.json()) as JSONWebKeySet);
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

/**
 * Highest-priority local role among the mapped IdP roles. P2 (QA 714b3f3): a mapping whose local_role is not a known
 * role (legacy / hand-edited row) is ignored; before, its priority index -1 beat every valid mapping. Exported for tests.
 */
export async function mapRoles(roles: Array<{ code: string; name: string }>): Promise<Role | null> {
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
    if (!priority.includes(local)) continue;
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
  const user = await identityLookup(() => repos.getUserByIdpSubject(payload.subject));
  // Same check as session authentication (loadActivePrincipal). Disabled/deleted users and users of a disabled or
  // missing department (or disabled parent) get exactly the same error as an unregistered subject.
  const principal = user ? await loadActivePrincipal(user.id) : null;
  if (!principal) throw new ForgeError("CON-4706", "Connector 主体未在 Forge 登记", 403);
  return principal;
}
