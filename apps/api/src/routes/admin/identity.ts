import { type FastifyInstance } from "fastify";
import {
  config,
  errors,
  hashPassword,
  ROLE_PERMISSIONS,
  type Role,
  USER_STATUSES,
} from "@forge/core";
import { assertCanGrant, assertCanManageUser, auditFilterFor, grantDefaultDataScope, loadVisibleUserOr404, maskArgsDeep, userFilterFor } from "@forge/governance";
import { oidcConfigured } from "@forge/identity";
import { repos, userUpdateAuditEntries, type UserRow } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  admin,
  writeAudit,
  requireBodyString,
  enumBody,
} from "../../plugins/http-helpers.js";
import { limitQuerySchema, parseInput, userCreateSchema } from "../../plugins/input-schema.js";

/**
 * User list DTO (I-USR-01): explicit whitelist instead of spreading the row. Field names stay snake_case because the
 * legacy console (apps/console/public/app.js) and smoke.ts read them; password_hash is never output, idp_subject and
 * is_emergency_admin only for platform_admin.
 */
function presentUser(user: UserRow, platformAdmin: boolean) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    data_scope: user.data_scope,
    org_unit_id: user.org_unit_id,
    status: user.status,
    created_at: user.created_at,
    updated_at: user.updated_at,
    ...(platformAdmin ? { idp_subject: user.idp_subject, is_emergency_admin: Boolean(Number(user.is_emergency_admin)) } : {}),
  };
}

export default async function adminIdentityRoutes(app: FastifyInstance): Promise<void> {
  // Users: a non-platform_admin sees and manages only users in its own data scope (filtered in SQL; others -> same 404
  // as nonexistent), cannot grant a higher role or wider dataScope (403 POL-2001) and cannot modify a platform_admin.
  app.get("/admin/api/users", async (request) => {
    const session = await admin(request, "user.view");
    const users = await repos.listUsers(await userFilterFor(session.principal));
    const platformAdmin = session.principal.role === "platform_admin";
    return { items: users.map((user) => presentUser(user, platformAdmin)) };
  });

  app.post("/admin/api/users", async (request) => {
    const session = await admin(request, "user.manage");
    const body = bodyOf(request);
    const { email } = parseInput(userCreateSchema, body);
    const status = enumBody(body, "status", USER_STATUSES);
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
      status,
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
    const status = enumBody(body, "status", USER_STATUSES);
    await repos.updateUser(target.id, { role, dataScope, status });
    // I-SCOPE plan A: main row in the (new) department; a real department change also writes user.org_transfer_out
    // in the old one. Today this route never moves a user, so before === after; the rule is kept for future moves.
    const after = await repos.getUserById(target.id);
    const entries = userUpdateAuditEntries(target.org_unit_id ?? null, after?.org_unit_id ?? null, { role, dataScope: stringBody(body, "dataScope"), ...(status !== undefined ? { status } : {}) });
    for (const entry of entries) await writeAudit(session, entry.action, "user", target.id, entry.details, { orgUnitId: entry.orgUnitId });
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
    const session = await admin(request, "audit.view");
    // I-SCOPE-13/14: rows filtered by the caller's dataScope (auditFilterFor); NULL-department rows only for dataScope all.
    return { items: await repos.listAudit(await auditFilterFor(session.principal), parseInput(limitQuerySchema(500), request.query ?? {}).limit ?? 100) };
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
