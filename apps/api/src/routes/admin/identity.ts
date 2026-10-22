import { type FastifyInstance } from "fastify";
import {
  config,
  errors,
  hashPassword,
  ROLE_PERMISSIONS,
  type Role,
} from "@forge/core";
import { assertCanGrant, assertCanManageUser, grantDefaultDataScope, loadVisibleUserOr404, maskArgsDeep, userFilterFor } from "@forge/governance";
import { oidcConfigured } from "@forge/identity";
import { repos } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  admin,
  writeAudit,
  requireBodyString,
} from "../../plugins/http-helpers.js";

export default async function adminIdentityRoutes(app: FastifyInstance): Promise<void> {
  // Users: a non-platform_admin sees and manages only users in its own data scope (filtered in SQL; others -> same 404
  // as nonexistent), cannot grant a higher role or wider dataScope (403 POL-2001) and cannot modify a platform_admin.
  app.get("/admin/api/users", async (request) => {
    const session = await admin(request, "user.view");
    const users = await repos.listUsers(await userFilterFor(session.principal));
    return { items: users.map((user) => ({ ...user, password_hash: undefined })) };
  });

  app.post("/admin/api/users", async (request) => {
    const session = await admin(request, "user.manage");
    const body = bodyOf(request);
    const email = requireBodyString(body, "email");
    if (await repos.getUserByEmail(email)) throw errors.conflict("邮箱已存在");
    const role = stringBody(body, "role", "user");
    if (!Object.keys(ROLE_PERMISSIONS).includes(role)) throw errors.invalid("非法角色");
    const dataScope = stringBody(body, "dataScope") || grantDefaultDataScope(session.principal, role as Role);
    assertCanGrant(session.principal, role, dataScope);
    const id = await repos.createUser({
      email,
      username: stringBody(body, "username", email.split("@")[0] ?? email),
      displayName: stringBody(body, "displayName", email),
      role,
      dataScope,
      // Always the caller's own department; body.orgUnitId is ignored.
      orgUnitId: session.principal.orgUnitId,
      passwordHash: stringBody(body, "password") ? hashPassword(stringBody(body, "password")) : null,
    });
    await writeAudit(session, "user.create", "user", id, { email, role });
    return { id };
  });

  // Updates role / dataScope / status only; body.orgUnitId is ignored (a user cannot be moved to another department here).
  app.patch("/admin/api/users/:id", async (request) => {
    const session = await admin(request, "user.manage");
    const body = bodyOf(request);
    const target = await loadVisibleUserOr404(session.principal, param(request, "id"));
    assertCanManageUser(session.principal, target);
    const role = stringBody(body, "role", target.role);
    if (!Object.keys(ROLE_PERMISSIONS).includes(role)) throw errors.invalid("非法角色");
    const dataScope = stringBody(body, "dataScope") || grantDefaultDataScope(session.principal, role as Role);
    assertCanGrant(session.principal, role, dataScope);
    const status = body.status !== undefined ? stringBody(body, "status") : undefined;
    await repos.updateUser(target.id, { role, dataScope, status });
    await writeAudit(session, "user.update", "user", target.id, { role, dataScope: stringBody(body, "dataScope"), ...(status !== undefined ? { status } : {}) });
    return { ok: true };
  });

  app.get("/admin/api/permissions", async (request) => {
    await admin(request, "role.view");
    return { roles: ROLE_PERMISSIONS };
  });

  app.get("/admin/api/org-units", async (request) => {
    await admin(request, "org.view");
    return { items: await repos.listOrgUnits() };
  });

  app.get("/admin/api/role-mappings", async (request) => {
    await admin(request, "sso.manage");
    return { items: await repos.listRoleMappings() };
  });

  app.post("/admin/api/role-mappings", async (request) => {
    const session = await admin(request, "sso.manage");
    const body = bodyOf(request);
    await repos.upsertRoleMapping(requireBodyString(body, "agentRoleCode"), stringBody(body, "agentRoleName"), requireBodyString(body, "localRole"));
    await writeAudit(session, "role_mapping.upsert", "oidc_role_mapping", null, maskArgsDeep(body));
    return { ok: true };
  });

  app.get("/admin/api/audit", async (request) => {
    await admin(request, "audit.view");
    return { items: await repos.listAudit(Number((request.query as Record<string, unknown>).limit ?? 100)) };
  });

  app.get("/admin/api/sso", async (request) => {
    await admin(request, "sso.manage");
    return {
      mode: config.SSO_MODE,
      tokenValidationMode: config.SSO_TOKEN_VALIDATION_MODE,
      oidcConfigured: oidcConfigured(),
      connectorEnabled: config.AGENT_CONNECTOR_ENABLED,
      connectorInbound: config.AGENT_CONNECTOR_INBOUND_ENABLED,
      connectorOutbound: config.AGENT_CONNECTOR_OUTBOUND_ENABLED,
      mappings: await repos.listRoleMappings(),
    };
  });
}
