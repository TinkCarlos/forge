import { type FastifyInstance } from "fastify";
import {
  config,
  defaultDataScope,
  errors,
  hashPassword,
  ROLE_PERMISSIONS,
  type Role,
} from "@forge/core";
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
  app.get("/admin/api/users", async (request) => {
    await admin(request, "user.view");
    const users = await repos.listUsers();
    return { items: users.map((user) => ({ ...user, password_hash: undefined })) };
  });

  app.post("/admin/api/users", async (request) => {
    const session = await admin(request, "user.manage");
    const body = bodyOf(request);
    const email = requireBodyString(body, "email");
    if (await repos.getUserByEmail(email)) throw errors.conflict("邮箱已存在");
    const role = stringBody(body, "role", "user");
    if (!Object.keys(ROLE_PERMISSIONS).includes(role)) throw errors.invalid("非法角色");
    if (session.principal.role !== "platform_admin" && ["platform_admin", "org_admin"].includes(role)) throw errors.forbidden("不能授予该角色");
    const id = await repos.createUser({
      email,
      username: stringBody(body, "username", email.split("@")[0] ?? email),
      displayName: stringBody(body, "displayName", email),
      role,
      dataScope: stringBody(body, "dataScope", defaultDataScope(role as Role)),
      orgUnitId: session.principal.orgUnitId,
      passwordHash: stringBody(body, "password") ? hashPassword(stringBody(body, "password")) : null,
    });
    await writeAudit(session, "user.create", "user", id, { email, role });
    return { id };
  });

  app.patch("/admin/api/users/:id", async (request) => {
    const session = await admin(request, "user.manage");
    const body = bodyOf(request);
    const target = await repos.getUserById(param(request, "id"));
    if (!target) throw errors.notFound("用户不存在");
    const role = stringBody(body, "role", target.role);
    if (!Object.keys(ROLE_PERMISSIONS).includes(role)) throw errors.invalid("非法角色");
    if (session.principal.role !== "platform_admin" && ["platform_admin", "org_admin"].includes(role)) throw errors.forbidden("不能授予该角色");
    await repos.updateUser(target.id, {
      role,
      dataScope: stringBody(body, "dataScope", defaultDataScope(role as Role)),
      status: body.status !== undefined ? stringBody(body, "status") : undefined,
    });
    await writeAudit(session, "user.update", "user", target.id, { role, dataScope: stringBody(body, "dataScope") });
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
    await writeAudit(session, "role_mapping.upsert", "oidc_role_mapping", null, body);
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
