import { ROLE_SCHEMAS } from "./roles.js";
import { API_ERROR_RESPONSE_SCHEMA } from "./errors.js";
import { CONFIGURATION_RESULT, IF_MATCH_PARAMETER } from "./configuration.js";
const text=(maxLength:number)=>({type:"string",maxLength});
const permissions={type:"array",maxItems:200,items:text(64)};
const roleOption={type:"object",additionalProperties:false,required:["id","key","name","status"],properties:{id:text(26),key:text(32),name:text(128),status:{enum:["active","disabled"]}}};
export const ROLE_OPTION_SCHEMA=roleOption;
export const ROLE_DTO_SCHEMA={type:"object",additionalProperties:false,required:["id","key","name","description","status","builtin","revision","permissions","can_manage","can_copy","can_reset"],properties:{...roleOption.properties,description:text(1024),builtin:{type:"boolean"},revision:{type:"integer",minimum:1},permissions,can_manage:{type:"boolean"},can_copy:{type:"boolean"},can_reset:{type:"boolean"},references:{type:"object",additionalProperties:{type:"integer",minimum:0}}}};
const catalog={type:"array",items:{type:"object",required:["key","domain","kind","description"],properties:{key:text(64),domain:text(32),kind:{const:"action"},description:text(128)}}};
const id={name:"id",in:"path",required:true,schema:text(26)},csrf={name:"X-CSRF-Token",in:"header",required:true,schema:text(128)};
function operation(permission:string,response:unknown,body?:unknown,parameters:unknown[]=[]){return{security:[{sessionCookie:[]}],"x-permission":permission,parameters,...(body?{requestBody:{required:true,content:{"application/json":{schema:body}}}}:{}),responses:{"200":{description:"成功",content:{"application/json":{schema:response}}},...Object.fromEntries([400,401,403,404,409,428].map(status=>[status,{description:"输入、权限、版本或引用拒绝；不会提交部分授权",content:{"application/json":{schema:API_ERROR_RESPONSE_SCHEMA}}}]))}};}
const created={type:"object",required:["id","revision"],properties:{id:text(26),revision:{const:1}}};
export const ROLES_OPENAPI={openapi:"3.1.0",info:{title:"Forge internal configurable roles",version:"0.1.0"},servers:[{url:"/admin/api"}],components:{securitySchemes:{sessionCookie:{type:"apiKey",in:"cookie",name:"forge_session"}}},paths:{
  "/permissions":{get:operation("role.view",{type:"object",required:["roles","catalog"],properties:{roles:{type:"object",additionalProperties:permissions},catalog}})},
  "/roles":{get:operation("role.view",{type:"object",required:["items","catalog","canCreate"],properties:{items:{type:"array",items:ROLE_DTO_SCHEMA},catalog,canCreate:{type:"boolean"}}}),post:operation("role.manage",created,ROLE_SCHEMAS.roleCreate.body,[csrf])},
  "/roles/{id}":{get:operation("role.view",ROLE_DTO_SCHEMA,undefined,[id]),patch:operation("role.manage",CONFIGURATION_RESULT,ROLE_SCHEMAS.rolePatch.body,[id,csrf,IF_MATCH_PARAMETER]),delete:operation("role.manage",CONFIGURATION_RESULT,undefined,[id,csrf,IF_MATCH_PARAMETER])},
  "/roles/{id}/copy":{post:operation("role.manage",created,ROLE_SCHEMAS.roleCopy.body,[id,csrf,IF_MATCH_PARAMETER])},
  "/roles/{id}/reset":{post:operation("role.manage",CONFIGURATION_RESULT,undefined,[id,csrf,IF_MATCH_PARAMETER])},
}};
