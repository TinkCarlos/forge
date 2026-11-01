import type { FastifyRequest } from "fastify";
import type { ErrorCode } from "@forge/core";
import { repos } from "@forge/store";
import { auditActorForRequest, readSession } from "./http-helpers.js";

const recorded = new WeakSet<FastifyRequest>();
const resources: Record<string, string> = { "api-keys": "api_key", "webhook-deliveries": "webhook_delivery", users: "user", roles: "role", agents: "agent", skills: "skill", mcp: "mcp_server", providers: "llm_provider", models: "llm_model", apps: "api_app", secrets: "secret", schedules: "schedule", "service-accounts": "service_account", plugins: "plugin", "role-mappings": "oidc_role_mapping", "tool-sources": "tool_source", approvals: "approval", runs: "run" };
const actions: Record<string, string> = {
  "POST /admin/api/roles":"role.create", "PATCH /admin/api/roles/:id":"role.update", "DELETE /admin/api/roles/:id":"role.delete", "POST /admin/api/roles/:id/copy":"role.copy", "POST /admin/api/roles/:id/reset":"role.reset",
  "POST /admin/api/users": "user.create", "PATCH /admin/api/users/:id": "user.update", "DELETE /admin/api/users/:id": "user.delete",
  "POST /admin/api/users/:id/password": "user.password.reset", "POST /admin/api/users/:id/revoke-sessions": "user.sessions.revoke", "PUT /admin/api/users/:id/sso-binding": "user.sso.bind", "DELETE /admin/api/users/:id/sso-binding": "user.sso.unbind",
  "POST /admin/api/agents": "agent.create", "PATCH /admin/api/agents/:id": "agent.update", "POST /admin/api/agents/:id/versions": "agent.version.create", "POST /admin/api/agents/:id/publish": "agent.publish", "POST /admin/api/agents/:id/run": "run.create",
  "POST /admin/api/mcp": "mcp.create", "PATCH /admin/api/mcp/:id": "mcp.update", "POST /admin/api/mcp/:id/refresh": "mcp.refresh",
  "POST /admin/api/skills": "skill.create", "PATCH /admin/api/skills/:id": "skill.update", "POST /admin/api/skills/:id/versions": "skill.version.create",
  "POST /admin/api/providers": "provider.create", "PATCH /admin/api/providers/:id": "provider.update", "POST /admin/api/providers/:id/models": "model.create", "PATCH /admin/api/models/:id": "model.update", "POST /admin/api/providers/:id/test": "provider.test",
  "POST /admin/api/apps": "app.create", "PATCH /admin/api/apps/:id": "app.update", "POST /admin/api/apps/:id/keys": "apikey.create", "POST /admin/api/api-keys/:id/rotate": "apikey.rotate", "POST /admin/api/api-keys/:id/revoke": "apikey.revoke",
  "POST /admin/api/secrets": "secret.create", "PATCH /admin/api/secrets/:id": "secret.update", "POST /admin/api/secrets/:id/rotate": "secret.rotate", "DELETE /admin/api/secrets/:id": "secret.delete",
  "POST /admin/api/schedules": "schedule.create", "PATCH /admin/api/schedules/:id": "schedule.update", "POST /admin/api/schedules/:id/enable": "schedule.enable", "POST /admin/api/schedules/:id/disable": "schedule.disable", "POST /admin/api/schedules/:id/run": "schedule.run",
  "POST /admin/api/service-accounts": "service_account.create", "PATCH /admin/api/service-accounts/:id": "service_account.update", "POST /admin/api/role-mappings": "role_mapping.upsert",
  "POST /admin/api/tool-sources/import": "tool_source.import", "POST /admin/api/plugins/install": "plugin.install", "POST /admin/api/plugins/:id/uninstall": "plugin.uninstall",
  "POST /admin/api/runs/:id/cancel": "run.cancel", "POST /admin/api/approvals/:id/decide": "approval.decide", "POST /admin/api/webhook-deliveries/:id/replay": "webhook.replay",
};

/** Fixed route metadata only: rejected request bodies and authentication tokens never enter operation logs. */
export async function auditRequestFailure(request: FastifyRequest, code: ErrorCode, status: number): Promise<void> {
  if (recorded.has(request)) return;
  const route = request.routeOptions?.url ?? "";
  const login = route === "/auth/local/login" || route === "/auth/oidc/callback";
  const authMutation = route === "/auth/password" || route === "/auth/logout";
  if (!login && !authMutation && (!route.startsWith("/admin/api/") || ["GET", "HEAD", "OPTIONS"].includes(request.method))) return;
  recorded.add(request);
  const actor = auditActorForRequest(request) ?? (request.cookies?.forge_session ? (await readSession(request).catch(() => null))?.principal : undefined);
  const domain = route.split("/")[3] ?? "";
  const resourceType = resources[domain] ?? (login || authMutation ? "user" : "configuration");
  const id = (request.params as Record<string, unknown> | undefined)?.id;
  const resourceId = typeof id === "string" && /^[a-zA-Z0-9_]{26}$/.test(id) ? id : authMutation ? actor?.id ?? null : null;
  const action = login ? (route.includes("oidc") ? "auth.login.oidc" : "auth.login.local") : authMutation ? (route === "/auth/logout" ? "auth.logout" : "auth.password.change") : actions[`${request.method} ${route}`] ?? "request.reject";
  try {
    await repos.audit({ actorType: actor?.type ?? "anonymous", actorId: actor?.id ?? null, action, resourceType, resourceId, orgUnitId: actor?.orgUnitId ?? null, outcome: status === 401 || status === 403 ? "denied" : "failure", details: { code, method: request.method, route } });
  } catch { request.log.error({ code: "SYS-9003", action }, "operation failure audit unavailable"); }
}
