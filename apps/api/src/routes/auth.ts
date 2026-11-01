import { type FastifyInstance } from "fastify";
import { config, errors, ForgeError, hashPassword, assertAccountPassword, OUTBOUND_BLOCKED_CODE, SSO_ERROR_CODES, SSO_FALLBACK_CODE } from "@forge/core";
import {
  buildOidcAuthorizeUrl,
  createSession,
  destroySession,
  handleOidcCallback,
  loginLocal,
  checkPassword,
  oidcConfigured,
  pendingOidcReturnTo,
} from "@forge/identity";
import { repos } from "@forge/store";
import { logSafeError } from "@forge/runtime";
import {
  bodyOf,
  readSession,
  readStoredSession,
  setSessionCookie,
  requireBodyString,
  sessionPayload,
  configurationWrite,
  configurationResult,
} from "../plugins/http-helpers.js";
import { sanitizeIdpError } from "../plugins/log-sanitize.js";
import { RETURN_TO_FALLBACK, safeReturnTo } from "../plugins/return-to.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../plugins/input-schema.js";
import { auditRequestFailure } from "../plugins/failure-audit.js";

/** AD: a full-page SSO navigation blocked by the outbound guard lands on the sign-in page, never on a JSON error. */
const SSO_ERROR_PAGE = "/next/sign-in";
function isOutboundBlocked(error: unknown): boolean {
  return error instanceof ForgeError && error.code === OUTBOUND_BLOCKED_CODE;
}
// P3-04: the browser SSO error whitelist (SSO_ERROR_CODES / SSO_FALLBACK_CODE) lives in @forge/core (sso-error-codes.ts).
/** P3-04: an API client asks for JSON and not for HTML; a browser navigation (text/html or none) gets the redirect. */
function wantsJson(accept: unknown): boolean {
  const value = typeof accept === "string" ? accept.toLowerCase() : "";
  return value.includes("application/json") && !value.includes("text/html");
}
function ssoErrorLocation(rawReturnTo: unknown, code: string = OUTBOUND_BLOCKED_CODE): string {
  const params = new URLSearchParams({ ssoError: SSO_ERROR_CODES.has(code) ? code : SSO_FALLBACK_CODE });
  // AE: the console sign-in page reads the post-login target from `redirect`. Keep it only when it survives the
  // S-30 check as given; a rejected value (falls back) or the default /next/ is dropped. URLSearchParams encodes it.
  if (typeof rawReturnTo === "string" && rawReturnTo) {
    const safe = safeReturnTo(rawReturnTo, config.FORGE_PUBLIC_URL);
    if (safe !== RETURN_TO_FALLBACK) params.set("redirect", safe);
  }
  return `${SSO_ERROR_PAGE}?${params.toString()}`;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/config", async () => ({
    localLogin: config.ALLOW_LOCAL_LOGIN,
    oidcConfigured: oidcConfigured(),
    ssoMode: config.SSO_MODE,
  }));

  app.post("/auth/local/login", { schema: ROUTE_SCHEMAS.localLogin, attachValidation: true }, async (request, reply) => {
    const body = bodyOf(request);
    assertValidInput(request);
    const email = requireBodyString(body, "email");
    const password = body.password;
    if (typeof password !== "string" || !password.length) throw errors.invalid("请输入密码", { field: "password" });
    const principal = await loginLocal(email, password, request.ip);
    const session = await createSession(principal);
    setSessionCookie(reply, session);
    await repos.audit({ actorType: "user", actorId: principal.id, action: "auth.login.local", resourceType: "user", resourceId: principal.id });
    return sessionPayload(session);
  });

  app.get("/auth/session", async (request) => {
    const session = await readSession(request);
    if (!session) throw errors.unauthorized();
    return sessionPayload(session);
  });

  app.post("/auth/password", { schema: ROUTE_SCHEMAS.authPassword, attachValidation: true }, async (request, reply) => {
    const session = await readSession(request);
    if (!session) throw errors.unauthorized();
    assertValidInput(request);
    const body = bodyOf(request);
    assertAccountPassword(body.newPassword, "newPassword");
    const target = await repos.getActiveUserById(session.userId);
    if (!target || !checkPassword(String(body.currentPassword), target.password_hash)) throw errors.invalid("当前密码错误", { field: "currentPassword" });
    const options = configurationWrite(request, session, "auth.password.change", "user", target.id, {}, target.org_unit_id);
    const revision = await repos.updateUser(target.id, { passwordHash: hashPassword(body.newPassword) }, { ...options, authorize: async (current, actor) => {
      if (!current || !actor || current.id !== actor.id || actor.revision !== session.principal.revision) throw errors.unauthorized();
      if (current.revision !== target.revision) throw errors.conflict("账号已变更，请重新打开后修改密码");
    } });
    reply.clearCookie("forge_session", { path: "/" });
    return configurationResult(reply, revision);
  });

  app.post("/auth/logout", { schema: ROUTE_SCHEMAS.noBody, attachValidation: true }, async (request, reply) => {
    assertValidInput(request); // P1: no body or {} only; a field -> 400, the session is kept
    const session = await readStoredSession(request);
    if (session) await destroySession(session.token);
    reply.clearCookie("forge_session", { path: "/" });
    // Y (#9): only a real session is audited. The session is already gone; an audit write failure must not fail logout.
    if (session) {
      await repos
        .audit({ actorType: "user", actorId: session.userId, action: "auth.logout", resourceType: "user", resourceId: session.userId })
        .catch((error: unknown) => request.log.warn({ err: logSafeError(error) }, "auth.logout audit failed"));
    }
    return { ok: true };
  });

  app.get("/auth/oidc/login", async (request, reply) => {
    if (!oidcConfigured()) throw new ForgeError("SSO-1201", { message: "SSO 尚未配置", httpStatus: 503, retryable: false });
    const query = request.query as Record<string, unknown>;
    // S-30: only a same-origin local path survives; anything else falls back to /next/.
    const returnTo = safeReturnTo(query.returnTo, config.FORGE_PUBLIC_URL);
    try {
      return reply.redirect(await buildOidcAuthorizeUrl(returnTo));
    } catch (error) {
      if (isOutboundBlocked(error)) {
        request.log.warn({ err: logSafeError(error) }, "oidc login rejected");
        return reply.redirect(ssoErrorLocation(query.returnTo));
      }
      throw error;
    }
  });

  app.get("/auth/oidc/callback", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const code = typeof query.code === "string" ? query.code : "";
    const state = typeof query.state === "string" ? query.state : "";
    const pendingReturnTo = state ? await pendingOidcReturnTo(state) : null;
    let result: Awaited<ReturnType<typeof handleOidcCallback>>;
    try {
      // P3-04: the IdP's own error (error=access_denied ...) is one fixed code; error_description is never used.
      // SSO-1212 hardening: the raw error / error_description never go into the redirect, a response or the logs; only
      // a plain OAuth error token is logged, anything else as [REDACTED] (sanitizeIdpError).
      if (query.error !== undefined) {
        throw new ForgeError("SSO-1212", { message: "身份提供方拒绝了登录", httpStatus: 401, retryable: false });
      }
      if (!code || !state) throw new ForgeError("SSO-1203", { message: "回调参数缺失", httpStatus: 400, retryable: false });
      result = await handleOidcCallback(code, state);
    } catch (error) {
      // AD: an outbound block always redirects (unchanged). P3-04: every other error redirects a browser to the sign-in
      // page with a whitelisted code only; an API client (Accept: application/json) keeps the JSON error.
      await auditRequestFailure(request, error instanceof ForgeError ? error.code : "SYS-9001", error instanceof ForgeError ? error.httpStatus : 500);
      if (isOutboundBlocked(error)) {
        request.log.warn({ err: logSafeError(error) }, "oidc callback rejected");
        return reply.redirect(ssoErrorLocation(pendingReturnTo));
      }
      if (wantsJson(request.headers.accept)) throw error;
      if (error instanceof ForgeError && error.code === "SSO-1212") request.log.warn({ code: error.code, idpError: sanitizeIdpError(query.error) }, "oidc callback: identity provider returned an error");
      else if (error instanceof ForgeError) request.log.warn({ err: logSafeError(error) }, "oidc callback rejected");
      else request.log.error({ err: logSafeError(error) }, "oidc callback failed");
      const ssoCode = error instanceof ForgeError ? error.code : SSO_FALLBACK_CODE;
      return reply.redirect(ssoErrorLocation(pendingReturnTo, ssoCode));
    }
    const { principal, returnTo } = result;
    const session = await createSession(principal);
    setSessionCookie(reply, session);
    await repos.audit({ actorType: "user", actorId: principal.id, action: "auth.login.oidc", resourceType: "user", resourceId: principal.id });
    return reply.redirect(safeReturnTo(returnTo, config.FORGE_PUBLIC_URL));
  });
}
