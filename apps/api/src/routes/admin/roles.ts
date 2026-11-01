import type { FastifyInstance } from "fastify";
import { errors, requireRevision, PERMISSION_CATALOG, ROLE_PERMISSIONS, type BuiltinRole, type Principal } from "@forge/core";
import { assertPermission, assertPermissionCeiling } from "@forge/governance";
import { toPrincipal } from "@forge/identity";
import { repos, type RoleRow, type RoleWrite } from "@forge/store";
import type { RoleDto } from "@forge/contracts";
import { admin, bodyOf, configurationResult, configurationWrite, param, stringBody } from "../../plugins/http-helpers.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../../plugins/input-schema.js";

function assertRoleManage(principal:Principal, role?:RoleRow|null, copy=false):void {
  assertPermission(principal, "role.manage");
  if(principal.dataScope!=="all") throw errors.forbidden("平台角色配置需要全部数据范围");
  if(role) assertPermissionCeiling(principal, copy && role.key==="platform_admin" ? PERMISSION_CATALOG.map(item=>item.key) : role.permissions_json);
}
function presentRole(role:RoleRow, principal:Principal):RoleDto {
  let canCopy=true, canReset=Boolean(role.builtin)&&role.key!=="platform_admin";
  try {assertRoleManage(principal, role, true);}catch{canCopy=false;canReset=false;}
  try {assertPermissionCeiling(principal, ROLE_PERMISSIONS[role.key as BuiltinRole]??[]);}catch{canReset=false;}
  return {id:role.id, key:role.key, name:role.name, description:role.description, status:role.status, builtin:Boolean(role.builtin), revision:role.revision, permissions:role.permissions_json, can_manage:canCopy&&role.key!=="platform_admin", can_copy:canCopy, can_reset:canReset};
}
function authorize(revision:number|undefined, desired?:string[], reset=false, copy=false):NonNullable<RoleWrite["authorize"]> {
  return async(target, actor)=>{
    if(!actor || (revision!==undefined && actor.revision!==revision)) throw errors.unauthorized();
    const principal=toPrincipal(actor);
    assertRoleManage(principal, target, copy);
    if(desired) assertPermissionCeiling(principal, desired);
    if(reset && target) assertPermissionCeiling(principal, ROLE_PERMISSIONS[target.key as BuiltinRole] ?? []);
  };
}
async function load(id:string):Promise<RoleRow> { const role=await repos.getRole(id); if(!role)throw errors.notFound("角色不存在"); return role; }

export default async function adminRoleRoutes(app:FastifyInstance):Promise<void> {
  app.get("/admin/api/permissions", async request=>{
    await admin(request, "role.view");
    return {catalog:PERMISSION_CATALOG, roles:Object.fromEntries((await repos.listRoles()).map(role=>[role.key, role.status==="active"?role.permissions_json:[]]))};
  });
  app.get("/admin/api/roles", async request=>{
    const session=await admin(request, "role.view");
    let canCreate=true;try{assertRoleManage(session.principal);}catch{canCreate=false;}
    return {items:(await repos.listRoles()).map(role=>presentRole(role, session.principal)), catalog:PERMISSION_CATALOG, canCreate};
  });
  app.get("/admin/api/roles/:id", async(request, reply)=>{
    const session=await admin(request, "role.view"); const role=await load(param(request, "id"));
    configurationResult(reply, role.revision);
    return {...presentRole(role, session.principal), references:await repos.roleReferences(role)};
  });
  app.post("/admin/api/roles", {schema: ROUTE_SCHEMAS.roleCreate, attachValidation:true}, async request=>{
    const session=await admin(request, "role.manage");assertRoleManage(session.principal);assertValidInput(request);
    const body = bodyOf(request);const permissions=body.permissions as string[];
    const id=await repos.createRole({key:String(body.key), name:String(body.name), description:stringBody(body, "description"), status:stringBody(body, "status", "active"), permissions},
      {expectedRevision:"system", audit:{actorType:"user", actorId:session.principal.id, action: "role.create", resourceType:"role", resourceId:null, orgUnitId:null}, authorize:authorize(session.principal.revision, permissions)});
    return {id, revision:1};
  });
  app.patch("/admin/api/roles/:id", {schema: ROUTE_SCHEMAS.rolePatch, attachValidation:true}, async(request, reply)=>{
    const session=await admin(request, "role.manage");const role=await load(param(request, "id"));assertRoleManage(session.principal, role);assertValidInput(request);
    const body = bodyOf(request);const permissions=body.permissions as string[]|undefined;
    const revision=await repos.updateRole(role.id, {name:body.name as string|undefined, description:body.description as string|undefined, status:body.status as string|undefined, permissions},
      {...configurationWrite(request, session, "role.update", "role", role.id, {}, null), authorize:authorize(session.principal.revision, permissions)});
    return configurationResult(reply, revision);
  });
  app.delete("/admin/api/roles/:id", {schema: ROUTE_SCHEMAS.noBody, attachValidation:true}, async(request, reply)=>{
    const session=await admin(request, "role.manage");const role=await load(param(request, "id"));assertRoleManage(session.principal, role);assertValidInput(request);
    return configurationResult(reply, await repos.updateRole(role.id, {}, {...configurationWrite(request, session, "role.delete", "role", role.id, {}, null), authorize:authorize(session.principal.revision)}, "delete"));
  });
  app.post("/admin/api/roles/:id/reset", {schema: ROUTE_SCHEMAS.noBody, attachValidation:true}, async(request, reply)=>{
    const session=await admin(request, "role.manage");const role=await load(param(request, "id"));assertRoleManage(session.principal, role);assertValidInput(request);
    return configurationResult(reply, await repos.updateRole(role.id, {}, {...configurationWrite(request, session, "role.reset", "role", role.id, {}, null), authorize:authorize(session.principal.revision, undefined, true)}, "reset"));
  });
  app.post("/admin/api/roles/:id/copy", {schema: ROUTE_SCHEMAS.roleCopy, attachValidation:true}, async request=>{
    const session=await admin(request, "role.manage");const role=await load(param(request, "id"));assertRoleManage(session.principal, role, true);assertValidInput(request);const body = bodyOf(request);
    const id=await repos.createRole({key:String(body.key), name:String(body.name), description:body.description as string|undefined, permissions:[]},
      {...configurationWrite(request, session, "role.copy", "role", role.id, {}, null), authorize:authorize(session.principal.revision, undefined, false, true)}, {id:role.id, revision:requireRevision(request.headers["if-match"])});
    return {id, revision:1};
  });
}
