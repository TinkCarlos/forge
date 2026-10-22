import { type FastifyInstance } from "fastify";
import { config, errors, ForgeError } from "@forge/core";
import {
  buildOidcAuthorizeUrl,
  createSession,
  destroySession,
  handleOidcCallback,
  loginLocal,
  oidcConfigured,
} from "@forge/identity";
import { repos } from "@forge/store";
import {
  bodyOf,
  readSession,
  readStoredSession,
  setSessionCookie,
  requireBodyString,
  sessionPayload,
} from "../plugins/http-helpers.js";
import { safeReturnTo } from "../plugins/return-to.js";

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/config", async () => ({
    localLogin: config.ALLOW_LOCAL_LOGIN,
    oidcConfigured: oidcConfigured(),
    ssoMode: config.SSO_MODE,
  }));

  app.post("/auth/local/login", async (request, reply) => {
    const body = bodyOf(request);
    const email = requireBodyString(body, "email");
    const password = requireBodyString(body, "password");
    const principal = await loginLocal(email, password);
    const session = createSession(principal);
    setSessionCookie(reply, session);
    await repos.audit({ actorType: "user", actorId: principal.id, action: "auth.login.local", resourceType: "user", resourceId: principal.id });
    return sessionPayload(session);
  });

  app.get("/auth/session", async (request) => {
    const session = await readSession(request);
    if (!session) throw errors.unauthorized();
    return sessionPayload(session);
  });

  app.post("/auth/logout", async (request, reply) => {
    const session = readStoredSession(request);
    if (session) destroySession(session.token);
    reply.clearCookie("forge_session", { path: "/" });
    // Y (#9): only a real session is audited. The session is already gone; an audit write failure must not fail logout.
    if (session) {
      await repos
        .audit({ actorType: "user", actorId: session.userId, action: "auth.logout", resourceType: "user", resourceId: session.userId })
        .catch((error: unknown) => request.log.warn({ err: error }, "auth.logout audit failed"));
    }
    return { ok: true };
  });

  app.get("/auth/oidc/login", async (request, reply) => {
    if (!oidcConfigured()) throw new ForgeError("SSO-1201", "SSO 尚未配置", 503);
    const query = request.query as Record<string, unknown>;
    // S-30: only a same-origin local path survives; anything else falls back to /next/.
    const returnTo = safeReturnTo(query.returnTo, config.FORGE_PUBLIC_URL);
    return reply.redirect(await buildOidcAuthorizeUrl(returnTo));
  });

  app.get("/auth/oidc/callback", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const code = typeof query.code === "string" ? query.code : "";
    const state = typeof query.state === "string" ? query.state : "";
    if (!code || !state) throw new ForgeError("SSO-1203", "回调参数缺失", 400);
    const { principal, returnTo } = await handleOidcCallback(code, state);
    const session = createSession(principal);
    setSessionCookie(reply, session);
    await repos.audit({ actorType: "user", actorId: principal.id, action: "auth.login.oidc", resourceType: "user", resourceId: principal.id });
    return reply.redirect(safeReturnTo(returnTo, config.FORGE_PUBLIC_URL));
  });
}
