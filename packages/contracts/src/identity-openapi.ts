import { ROLE_OPTION_SCHEMA } from "./roles-openapi.js";
import { ROUTE_SCHEMAS } from "./route-schemas.js";
import { API_ERROR_RESPONSE_SCHEMA } from "./errors.js";
import { CONFIGURATION_RESULT, IF_MATCH_PARAMETER } from "./configuration.js";
const text = (maxLength: number) => ({ type: "string", maxLength });
const nullableId = { type: ["string", "null"], maxLength: 26 };
export const USER_DTO_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["id", "revision", "username", "email", "display_name", "role", "data_scope", "org_unit_id", "status", "created_at", "updated_at", "has_local_password", "can_manage","roles","additional_role_ids","effective_permissions"],
  properties: { roles:{type:"array",maxItems:33,items:ROLE_OPTION_SCHEMA},additional_role_ids:{type:"array",maxItems:32,items:text(26)},effective_permissions:{type:"array",maxItems:200,items:text(64)},id: text(26), revision: { type:"integer", minimum:1 }, username: text(64), email: text(255), display_name: text(128), role: text(32), data_scope: text(16), org_unit_id: nullableId, status: { type:"string",enum:["active","disabled"] }, created_at:{type:"string",format:"date-time"}, updated_at:{type:"string",format:"date-time"}, has_local_password:{type:"boolean"}, can_manage:{type:"boolean"}, idp_subject:{type:["string","null"],maxLength:255}, idp_issuer:{type:["string","null"],maxLength:2048}, is_emergency_admin:{type:"boolean"} },
};
const audit = { type:"object", required:["id","actor_type","actor_id","actor_name","outcome","action","resource_type","resource_id","org_unit_id","created_at","details_json"], properties:{id:text(26),actor_type:text(16),actor_id:nullableId,actor_name:{type:["string","null"],maxLength:128},outcome:{enum:["success","failure","denied"]},action:text(64),resource_type:text(32),resource_id:nullableId,org_unit_id:nullableId,created_at:{type:"string",format:"date-time"},details_json:{}} };
const page = (items:unknown) => ({ type:"object",required:["items","nextCursor"],properties:{items:{type:"array",maxItems:200,items},nextCursor:{type:["string","null"],maxLength:512}} });
const csrf = { name:"X-CSRF-Token",in:"header",required:true,schema:text(128) };
const id = { name:"id",in:"path",required:true,schema:text(26) };
const fail = (description:string) => ({description,content:{"application/json":{schema:API_ERROR_RESPONSE_SCHEMA}}});
function operation(permission:string, response:unknown, body?:unknown, parameters:unknown[] = []) {
  return { security:[{sessionCookie:[]}],"x-permission":permission,parameters,...(body ? {requestBody:{required:true,content:{"application/json":{schema:body}}}} : {}), responses:{"200":{description:"成功；敏感凭据只写不读",content:{"application/json":{schema:response}}},"400":fail("参数校验失败"),"401":fail("账号或会话不可用"),"403":fail("权限/作用域/CSRF拒绝"),"404":fail("资源不存在或不可见"),"409":fail("标识占用、最后管理员保护或版本冲突"),"428":fail("缺少If-Match")}};
}
const query = (schema:{properties:Record<string,unknown>}) => Object.entries(schema.properties).map(([name,schema])=>({name,in:"query",required:false,schema}));
export const IDENTITY_OPENAPI = {
  openapi:"3.1.0",info:{title:"Forge internal accounts and operation logs",version:"0.1.0"},servers:[{url:"/admin/api"}],components:{securitySchemes:{sessionCookie:{type:"apiKey",in:"cookie",name:"forge_session"}}},
  paths:{
    "/users":{get:operation("user.view",{...page(USER_DTO_SCHEMA),properties:{...page(USER_DTO_SCHEMA).properties,grantableRoles:{type:"array",items:text(32)},roleOptions:{type:"array",items:ROLE_OPTION_SCHEMA},canCreate:{type:"boolean"}}},undefined,query(ROUTE_SCHEMAS.usersList.querystring)),post:operation("user.manage",{type:"object",required:["id","revision"],properties:{id:text(26),revision:{const:1}}},ROUTE_SCHEMAS.userCreate.body,[csrf])},
    "/users/{id}":{get:operation("user.view",USER_DTO_SCHEMA,undefined,[id]),patch:operation("user.manage",CONFIGURATION_RESULT,ROUTE_SCHEMAS.userPatch.body,[id,csrf,IF_MATCH_PARAMETER]),delete:operation("user.manage",CONFIGURATION_RESULT,undefined,[id,csrf,IF_MATCH_PARAMETER])},
    "/users/{id}/password":{post:operation("user.manage",CONFIGURATION_RESULT,ROUTE_SCHEMAS.userPassword.body,[id,csrf,IF_MATCH_PARAMETER])},
    "/users/{id}/revoke-sessions":{post:operation("user.manage",CONFIGURATION_RESULT,undefined,[id,csrf,IF_MATCH_PARAMETER])},
    "/users/{id}/sso-binding":{put:operation("user.manage+sso.manage+platform_admin",CONFIGURATION_RESULT,ROUTE_SCHEMAS.userSsoBinding.body,[id,csrf,IF_MATCH_PARAMETER]),delete:operation("user.manage+sso.manage+platform_admin",CONFIGURATION_RESULT,undefined,[id,csrf,IF_MATCH_PARAMETER])},
    "/audit":{get:operation("audit.view",page(audit),undefined,query(ROUTE_SCHEMAS.auditList.querystring))},
    "/audit/{id}":{get:operation("audit.view",audit,undefined,[id])},
    "/auth/password":{post:{...operation("authenticated-self",CONFIGURATION_RESULT,ROUTE_SCHEMAS.authPassword.body,[csrf,IF_MATCH_PARAMETER]),servers:[{url:"/"}]}},
  },
};
