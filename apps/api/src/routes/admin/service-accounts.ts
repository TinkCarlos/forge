import { toPrincipal } from "@forge/identity";
import { type FastifyInstance } from "fastify";
import { errors, ForgeError, readAuthorization, type Principal } from "@forge/core";
import { assertCanGrant, assertPermission, assertPermissionCeiling, inOrgScope, orgScopeIds } from "@forge/governance";
import { repos, type RoleRow, type ServiceAccountRow, type ServiceAccountWrite } from "@forge/store";
import { bodyOf, param, stringBody, admin, configurationWrite, configurationResult, requireBodyString } from "../../plugins/http-helpers.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../../plugins/input-schema.js";

// Service accounts (permissions.md §3.4): machine identities for schedules/integrations.
// Independent role + data scope, cannot log in. Disabling one pauses its schedules (SCD-4801).
const SERVICE_ACCOUNT_DATA_SCOPES = ["org", "all"];
const SERVICE_ACCOUNT_STATUSES = ["active", "disabled"];

export function presentServiceAccount(row: ServiceAccountRow): Record<string, unknown> {
  return {
    id: row.id,
    revision: row.revision,
    key: row.key,
    name: row.name,
    description: row.description,
    orgUnitId: row.org_unit_id,
    role: row.role,
    roles:readAuthorization(row.authorization_json).roles,
    additionalRoleIds:readAuthorization(row.authorization_json).roles.filter(role=>role.key!==row.role).map(role=>role.id),
    effectivePermissions:readAuthorization(row.authorization_json).permissions,
    dataScope: row.data_scope,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Visible when dataScope is all, or the account belongs to the caller's department or one of its sub-departments (as runs). */
export function serviceAccountVisible(scopeIds: string[] | null, row: ServiceAccountRow | null): row is ServiceAccountRow {
  if (!row) return false;
  return inOrgScope(scopeIds, row.org_unit_id);
}

function validateRoleAndScope(principal: Principal, role: string, dataScope: string,roles:RoleRow[]): void {
  assertCanGrant(principal,role,dataScope,roles);
  if (role === "platform_admin") throw new ForgeError("SCD-4804", { message: "服务账号不能是 platform_admin", httpStatus: 400, retryable: false });
  if (principal.role !== "platform_admin" && ["platform_admin", "org_admin"].includes(role)) throw errors.forbidden("不能授予该角色");
  if (!SERVICE_ACCOUNT_DATA_SCOPES.includes(dataScope)) throw errors.invalid("服务账号数据范围只能是 org 或 all");
  if (dataScope === "all" && principal.dataScope !== "all") throw errors.forbidden("不能授予超出自身的数据范围");
}

function authorizeMutation(revision:number|undefined,role:string,dataScope:string):NonNullable<ServiceAccountWrite["authorize"]>{
  return async(target,actor,roles,connection)=>{
    if(!actor || (revision!==undefined && actor.revision!==revision))throw errors.unauthorized();
    const principal=toPrincipal(actor);assertPermission(principal,"service_account.manage");
    if(target){
      if(!serviceAccountVisible(await orgScopeIds(principal,connection),target))throw errors.notFound("服务账号不存在");
      if(principal.role!=="platform_admin" && (["platform_admin","org_admin"].includes(target.role)||readAuthorization(target.authorization_json).roles.some(role=>["platform_admin","org_admin"].includes(role.key))))throw errors.forbidden("不能管理该服务账号角色");
      assertPermissionCeiling(principal,readAuthorization(target.authorization_json).grantedPermissions);
    }
    validateRoleAndScope(principal,role,dataScope,roles);
  };
}

export default async function adminServiceAccountRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/api/service-accounts", async (request) => {
    const session = await admin(request, "service_account.manage");
    const rows = await repos.listServiceAccounts(await orgScopeIds(session.principal));
    const roleOptions=(await repos.listRoles()).filter(role=>{try{validateRoleAndScope(session.principal,role.key,"org",[role]);return role.status==="active";}catch{return false;}});
    return { items: rows.map(presentServiceAccount),roleOptions:roleOptions.map(({id,key,name,status})=>({id,key,name,status})) };
  });

  app.post("/admin/api/service-accounts", { schema: ROUTE_SCHEMAS.serviceAccountCreate, attachValidation: true }, async (request) => {
    const session = await admin(request, "service_account.manage");
    assertValidInput(request);
    const body = bodyOf(request);
    const name = requireBodyString(body, "name");
    const key = stringBody(body, "key", `svc-${Date.now()}`);
    if (await repos.getServiceAccountByKey(key)) throw errors.conflict("服务账号 key 已存在");
    const role = stringBody(body, "role", "user");
    const dataScope = stringBody(body, "dataScope", "org");
    const id = await repos.createServiceAccount({
      key,
      name,
      description: stringBody(body, "description", ""),
      orgUnitId: session.principal.orgUnitId,
      role,
      additionalRoleIds:body.additionalRoleIds as string[]|undefined,
      dataScope,
      createdBy: session.principal.id,
    },{expectedRevision:"system",audit:{actorType:"user",actorId:session.principal.id,action: "service_account.create",resourceType:"service_account",resourceId:null,orgUnitId:session.principal.orgUnitId},authorize:authorizeMutation(session.principal.revision,role,dataScope)});
    return { id,revision:1 };
  });

  app.get("/admin/api/service-accounts/:id", async (request, reply) => {
    const session = await admin(request, "service_account.manage");
    const row = await repos.getServiceAccount(param(request, "id"));
    if (!serviceAccountVisible(await orgScopeIds(session.principal), row)) throw errors.notFound("服务账号不存在");
    configurationResult(reply, Number(row.revision));
    return presentServiceAccount(row);
  });

  app.patch("/admin/api/service-accounts/:id", { schema: ROUTE_SCHEMAS.serviceAccountPatch, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "service_account.manage");
    const row = await repos.getServiceAccount(param(request, "id"));
    if (!serviceAccountVisible(await orgScopeIds(session.principal), row)) throw errors.notFound("服务账号不存在");
    assertValidInput(request);
    const body = bodyOf(request);
    const role = stringBody(body, "role", row.role);
    const dataScope = stringBody(body, "dataScope", row.data_scope);
    const status = body.status !== undefined ? stringBody(body, "status") : undefined;
    if (status !== undefined && !SERVICE_ACCOUNT_STATUSES.includes(status)) throw errors.invalid("状态只能是 active 或 disabled");
    const fields = {
      additionalRoleIds:body.additionalRoleIds as string[]|undefined,
      name: body.name !== undefined ? stringBody(body, "name") : undefined,
      description: body.description !== undefined ? stringBody(body, "description") : undefined,
      role: body.role !== undefined ? role : undefined,
      dataScope: body.dataScope !== undefined ? dataScope : undefined,
      status,
    };
    const before = { name: row.name, description: row.description, role: row.role, dataScope: row.data_scope, status: row.status };
    const revision = await repos.updateServiceAccount(row.id, fields, {...configurationWrite(request, session, status === "disabled" ? "service_account.disable" : "service_account.update", "service_account", row.id, { before, changes: fields }, row.org_unit_id),authorize:authorizeMutation(session.principal.revision,role,dataScope)});
    return configurationResult(reply, revision);
  });
}
