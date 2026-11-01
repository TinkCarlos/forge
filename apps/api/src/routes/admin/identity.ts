import { type FastifyInstance } from "fastify";
import {
  config,
  requireRevision,
  errors,
  hashPassword,
  assertAccountPassword,
  readAuthorization,
  type Role,
  USER_STATUSES,
} from "@forge/core";
import { assertPermission, canSeeUser, assertCanGrant, assertCanManageUser, assertOrgWritable, auditFilterFor, grantDefaultDataScope, loadVisibleUserOr404, maskArgsDeep, userFilterFor } from "@forge/governance";
import { toPrincipal, oidcConfigured } from "@forge/identity";
import { isAuditTimestamp, type UserDto } from "@forge/contracts";
import { repos, type AccountWrite, type UserRow } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  admin,
  configurationWrite,
  configurationResult,
  requireBodyString,
  enumBody,
} from "../../plugins/http-helpers.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../../plugins/input-schema.js";

const PLATFORM_WRITE_MESSAGE = "平台级资源仅数据范围为全部（all）的管理员可修改";

/**
 * User list DTO (I-USR-01): explicit whitelist instead of spreading the row. Field names stay snake_case because the
 * legacy console (apps/console/public/app.js) and smoke.ts read them; password_hash is never output, idp_subject and
 * is_emergency_admin only for platform_admin.
 */
function presentUser(user: UserRow, session: { principal: import("@forge/core").Principal }): UserDto {
  let canManage = true;
  try { assertPermission(session.principal, "user.manage"); assertCanManageUser(session.principal, user); } catch { canManage = false; }
  return {
    id: user.id, revision: user.revision, username: user.username, email: user.email, display_name: user.display_name,
    role: user.role, data_scope: user.data_scope, org_unit_id: user.org_unit_id, status: user.status,
    created_at: user.created_at, updated_at: user.updated_at,
    roles:readAuthorization(user.authorization_json).roles, additional_role_ids:readAuthorization(user.authorization_json).roles.filter(role=>role.key!==user.role).map(role=>role.id), effective_permissions:readAuthorization(user.authorization_json).permissions,
    has_local_password: Boolean(user.password_hash), can_manage: canManage,
    ...(session.principal.role === "platform_admin" ? { idp_subject: user.idp_subject, idp_issuer: user.idp_issuer ?? null, is_emergency_admin: Boolean(Number(user.is_emergency_admin)) } : {}),
  };
}

function authorizeMutation(actorRevision: number | undefined, desired?: { role: string; dataScope: string; orgUnitId: string | null }, binding = false): NonNullable<AccountWrite["authorize"]> {
  return async (target, actor, roles, connection) => {
    if (!actor) throw errors.unauthorized();
    if (actorRevision !== undefined && actorRevision !== actor.revision) throw errors.unauthorized("账号已变更，请重新登录");
    const principal = toPrincipal(actor);
    assertPermission(principal, "user.manage");
    if (target) {
      if (!(await canSeeUser(principal, target, connection))) throw errors.notFound("用户不存在");
      assertCanManageUser(principal, target);
    }
    if (binding) {
      assertPermission(principal, "sso.manage");
      if (principal.role !== "platform_admin") throw errors.forbidden();
    }
    if (desired) {
      assertCanGrant(principal, desired.role, desired.dataScope, roles ?? []);
      if (!target || target.org_unit_id !== desired.orgUnitId) {
        await assertOrgWritable(principal, desired.orgUnitId, undefined, connection);
        if (desired.orgUnitId && !(await repos.getActiveOrgUnit(desired.orgUnitId, connection))) throw errors.invalid("部门不存在或已停用", { field: "orgUnitId" });
      }
    }
  };
}

export default async function adminIdentityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/api/users", { schema: ROUTE_SCHEMAS.usersList, attachValidation: true }, async request => {
    const session = await admin(request, "user.view");
    assertValidInput(request, "querystring");
    const q = request.query as Record<string, string>;
    const page = await repos.listUsersPage(await userFilterFor(session.principal), { q: q.q, status: q.status, cursor: q.cursor, limit: q.limit ? Number(q.limit) : 50 });
    const roleOptions = (await repos.listRoles()).filter(role => {
      if (role.status !== "active") return false;
      try { assertCanGrant(session.principal, role.key, grantDefaultDataScope(session.principal, role.key),[role]); return true; } catch { return false; }
    });
    const grantableRoles = roleOptions.map(role=>role.key);
    let canCreate = true;
    try { assertPermission(session.principal, "user.manage"); await assertOrgWritable(session.principal, session.principal.orgUnitId); } catch { canCreate = false; }
    return { ...page, items: page.items.map(user => presentUser(user, session)), grantableRoles, roleOptions:roleOptions.map(({id,key,name,status})=>({id,key,name,status})), canCreate };
  });

  app.get("/admin/api/users/:id", async request => {
    const session = await admin(request, "user.view");
    return presentUser(await loadVisibleUserOr404(session.principal, param(request, "id")), session);
  });

  app.post("/admin/api/users", { schema: ROUTE_SCHEMAS.userCreate, attachValidation: true }, async request => {
    const session = await admin(request, "user.manage");
    assertValidInput(request);
    const body = bodyOf(request);
    const email = String(body.email).trim();
    const role = stringBody(body, "role", "user");
    const dataScope = stringBody(body, "dataScope") || grantDefaultDataScope(session.principal, role as Role);
    const orgUnitId = body.orgUnitId === undefined ? session.principal.orgUnitId : body.orgUnitId as string | null;
    if (body.password !== undefined) assertAccountPassword(body.password);
    const id = await repos.createUser({ email, username: stringBody(body, "username", email.split("@")[0] ?? email), displayName: stringBody(body, "displayName", email),
      role, additionalRoleIds:body.additionalRoleIds as string[] | undefined, dataScope, orgUnitId, status: enumBody(body, "status", USER_STATUSES), passwordHash: body.password === undefined ? null : hashPassword(body.password as string),
    }, { expectedRevision: "system", audit: { actorType: "user", actorId: session.principal.id, action: "user.create", resourceType: "user", resourceId: null, orgUnitId }, authorize: authorizeMutation(session.principal.revision, { role, dataScope, orgUnitId }) });
    return { id, revision: 1 };
  });

  app.patch("/admin/api/users/:id", { schema: ROUTE_SCHEMAS.userPatch, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "user.manage");
    const target = await loadVisibleUserOr404(session.principal, param(request, "id"));
    assertCanManageUser(session.principal, target);
    assertValidInput(request);
    const body = bodyOf(request);
    const role = stringBody(body, "role", target.role);
    const dataScope = stringBody(body, "dataScope") || (role === target.role ? target.data_scope : grantDefaultDataScope(session.principal, role as Role));
    const orgUnitId = body.orgUnitId === undefined ? target.org_unit_id : body.orgUnitId as string | null;
    const options = configurationWrite(request, session, "user.update", "user", target.id, {}, orgUnitId);
    const revision = await repos.updateUser(target.id, { role, additionalRoleIds:body.additionalRoleIds as string[] | undefined, dataScope, orgUnitId, status: enumBody(body, "status", USER_STATUSES),
      ...(body.username !== undefined ? { username: String(body.username) } : {}), ...(body.email !== undefined ? { email: String(body.email) } : {}), ...(body.displayName !== undefined ? { displayName: String(body.displayName) } : {}),
    }, { ...options, authorize: authorizeMutation(session.principal.revision, { role, dataScope, orgUnitId }) });
    return configurationResult(reply, revision);
  });

  app.delete("/admin/api/users/:id", { schema: ROUTE_SCHEMAS.noBody, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "user.manage");
    const target = await loadVisibleUserOr404(session.principal, param(request, "id"));
    assertCanManageUser(session.principal, target);
    assertValidInput(request);
    const revision = await repos.updateUser(target.id, { status: "deleted" }, { ...configurationWrite(request, session, "user.delete", "user", target.id, {}, target.org_unit_id), authorize: authorizeMutation(session.principal.revision) });
    return configurationResult(reply, revision);
  });

  app.post("/admin/api/users/:id/password", { schema: ROUTE_SCHEMAS.userPassword, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "user.manage");
    const target = await loadVisibleUserOr404(session.principal, param(request, "id"));
    assertCanManageUser(session.principal, target);
    assertValidInput(request);
    const password = bodyOf(request).password;
    assertAccountPassword(password);
    const revision = await repos.updateUser(target.id, { passwordHash: hashPassword(password) }, { ...configurationWrite(request, session, "user.password.reset", "user", target.id, {}, target.org_unit_id), authorize: authorizeMutation(session.principal.revision) });
    return configurationResult(reply, revision);
  });

  app.post("/admin/api/users/:id/revoke-sessions", { schema: ROUTE_SCHEMAS.noBody, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "user.manage");
    const target = await loadVisibleUserOr404(session.principal, param(request, "id"));
    assertCanManageUser(session.principal, target);
    assertValidInput(request);
    const revision = await repos.updateUser(target.id, { revokeSessions: true }, { ...configurationWrite(request, session, "user.sessions.revoke", "user", target.id, {}, target.org_unit_id), authorize: authorizeMutation(session.principal.revision) });
    return configurationResult(reply, revision);
  });

  app.put("/admin/api/users/:id/sso-binding", { schema: ROUTE_SCHEMAS.userSsoBinding, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "user.manage");
    const target = await loadVisibleUserOr404(session.principal, param(request, "id"));
    assertPermission(session.principal, "sso.manage");
    if (session.principal.role !== "platform_admin") throw errors.forbidden();
    assertValidInput(request);
    const subject = String(bodyOf(request).subject);
    if (!subject.trim() || /[\u0000-\u001f\u007f]/u.test(subject)) throw errors.invalid("SSO subject格式无效", { field: "subject" });
    if (!config.OIDC_ISSUER) throw errors.invalid("请先配置SSO身份源");
    const revision = await repos.bindUserIdentity(target.id, subject, config.OIDC_ISSUER, { ...configurationWrite(request, session, "user.sso.bind", "user", target.id, {}, null), authorize: authorizeMutation(session.principal.revision, undefined, true) });
    return configurationResult(reply, revision);
  });

  app.delete("/admin/api/users/:id/sso-binding", { schema: ROUTE_SCHEMAS.noBody, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "user.manage");
    const target = await loadVisibleUserOr404(session.principal, param(request, "id"));
    assertPermission(session.principal, "sso.manage");
    if (session.principal.role !== "platform_admin") throw errors.forbidden();
    assertValidInput(request);
    const revision = await repos.bindUserIdentity(target.id, null, null, { ...configurationWrite(request, session, "user.sso.unbind", "user", target.id, {}, null), authorize: authorizeMutation(session.principal.revision, undefined, true) });
    return configurationResult(reply, revision);
  });

  app.get("/admin/api/org-units", async (request) => {
    await admin(request, "org.view");
    return { items: await repos.listOrgUnits() };
  });

  app.get("/admin/api/role-mappings", async (request) => {
    await admin(request, "sso.manage");
    return { items: await repos.listRoleMappings() };
  });

  app.post("/admin/api/role-mappings", { schema: ROUTE_SCHEMAS.roleMappingUpsert, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "sso.manage");
    // P3 / P0-03 pattern: oidc_role_mappings is platform-wide (no department column) -> needs dataScope=all.
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE);
    assertValidInput(request);
    const body = bodyOf(request);
    const mapping = { agentRoleCode: requireBodyString(body, "agentRoleCode"), agentRoleName: stringBody(body, "agentRoleName"), localRole: requireBodyString(body, "localRole") };
    const existing = (await repos.listRoleMappings()).find((row) => row.agent_role_code === mapping.agentRoleCode);
    const revision = await repos.upsertRoleMapping(mapping.agentRoleCode, mapping.agentRoleName, mapping.localRole, {
      expectedRevision: existing || request.headers["if-match"] !== undefined ? requireRevision(request.headers["if-match"]) : "system",
      createOnly: !existing,
      authorize:async(_target,actor,roles)=>{
        if(!actor || actor.revision!==session.principal.revision)throw errors.unauthorized();
        const principal=toPrincipal(actor);assertPermission(principal,"sso.manage");
        if(principal.dataScope!=="all")throw errors.forbidden(PLATFORM_WRITE_MESSAGE);
        assertCanGrant(principal,mapping.localRole,"self",roles??[]);
      },
      audit: { actorType: "user", actorId: session.principal.id, action: "role_mapping.upsert", resourceType: "oidc_role_mapping", resourceId: existing ? String(existing.id) : null, details: maskArgsDeep(mapping), orgUnitId: null },
    });
    return configurationResult(reply, revision);
  });

  app.get("/admin/api/audit", { schema: ROUTE_SCHEMAS.auditList, attachValidation: true }, async (request) => {
    const session = await admin(request, "audit.view");
    assertValidInput(request, "querystring");
    const q = request.query as Record<string, string>;
    for (const field of ["from", "to"] as const) if (q[field] && !isAuditTimestamp(q[field])) throw errors.invalid("请输入包含时区的有效RFC3339时间", { field });
    if (q.from && q.to && Date.parse(q.from) > Date.parse(q.to)) throw errors.invalid("开始时间不能晚于结束时间", { field: "to" });
    return repos.listAuditPage(await auditFilterFor(session.principal), { ...q, limit: q.limit ? Number(q.limit) : 50 });
  });

  app.get("/admin/api/audit/:id", async request => {
    const session = await admin(request, "audit.view");
    const page = await repos.listAuditPage(await auditFilterFor(session.principal), { limit: 1 }, param(request, "id"));
    if (!page.items[0]) throw errors.notFound("操作日志不存在");
    return page.items[0];
  });

  app.get("/admin/api/sso", async (request) => {
    const sessionForSso=(await admin(request, "sso.manage")).principal;
    return {
      mode: config.SSO_MODE,
      issuer: config.OIDC_ISSUER ?? null,
      tokenValidationMode: config.SSO_TOKEN_VALIDATION_MODE,
      oidcConfigured: oidcConfigured(),
      connectorEnabled: config.AGENT_CONNECTOR_ENABLED,
      connectorInbound: config.AGENT_CONNECTOR_INBOUND_ENABLED,
      connectorOutbound: config.AGENT_CONNECTOR_OUTBOUND_ENABLED,
      mappings: await repos.listRoleMappings(),
      roleOptions:(await repos.listRoles()).filter(role=>{try{assertCanGrant(sessionForSso,role.key,"self",[role]);return role.status==="active";}catch{return false;}}).map(({id,key,name,status})=>({id,key,name,status})),
    };
  });
}
