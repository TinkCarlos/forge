import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/app.js";
import { newId, hashPassword } from "@forge/core";
import { createSession, sessionCookieValue, toPrincipal } from "@forge/identity";
import { execute, repos } from "@forge/store";
const ids: string[] = [], policyIds: string[] = [], userIds: string[] = [];
let app: FastifyInstance, headers: Record<string,string>;
async function auth(id: string) { const session=await createSession(toPrincipal((await repos.getUserById(id))!)); return {cookie:`forge_session=${sessionCookieValue(session)}`,"x-csrf-token":session.csrfToken}; }
beforeAll(async()=>{app=await buildApp({logger:false});await app.ready();headers=await auth("01J00000000000000000000001");});
afterAll(async()=>{for(const id of ids){await execute("UPDATE job_definitions SET published_version_id=NULL WHERE id=?",[id]);await execute("DELETE FROM job_definition_versions WHERE job_id=?",[id]);await execute("DELETE FROM job_definitions WHERE id=?",[id]);await execute("DELETE FROM audit_logs WHERE resource_id=?",[id]);}for(const id of policyIds)await execute("DELETE FROM data_policies WHERE id=?",[id]);for(const id of userIds){await execute("DELETE FROM auth_sessions WHERE user_id=?",[id]);await execute("DELETE FROM users WHERE id=?",[id]);}await app?.close();});
async function create() {
 const target=(await app.inject({url:"/admin/api/job-targets",headers})).json().items[0];expect(target).toBeDefined();
 const response=await app.inject({method:"POST",url:"/admin/api/jobs",headers,payload:{key:`job-${newId().toLowerCase()}`,name:"API任务",description:"原始说明",businessType:"technical",draft:{schemaVersion:1,target:{kind:target.kind,key:target.key,version:target.version,checksum:target.checksum},inputSchema:{type:"object"},outputSchema:{},nodes:[]}}});
 expect(response.statusCode,response.body).toBe(201);ids.push(response.json().id);return response.json();
}
it("creates, reads, updates, publishes immutable versions and rejects stale updates through the authenticated API",async()=>{
 const job=await create();expect(job).toMatchObject({status:"disabled",revision:1});
 const get=await app.inject({url:`/admin/api/jobs/${job.id}`,headers});expect(get.headers.etag).toBe('"1"');
 const edit=await app.inject({method:"PATCH",url:`/admin/api/jobs/${job.id}`,headers:{...headers,"if-match":'"1"'},payload:{name:"修改任务"}});expect(edit.statusCode,edit.body).toBe(200);expect(edit.json().description).toBe("原始说明");
 expect((await app.inject({method:"PATCH",url:`/admin/api/jobs/${job.id}`,headers:{...headers,"if-match":'"1"'},payload:{name:"旧页面"}})).statusCode).toBe(409);
 const publish=await app.inject({method:"POST",url:`/admin/api/jobs/${job.id}/publish`,headers:{...headers,"if-match":'"2"'},payload:{}});expect(publish.statusCode,publish.body).toBe(201);
 const versions=await app.inject({url:`/admin/api/jobs/${job.id}/versions`,headers});expect(versions.statusCode,versions.body).toBe(200);expect(versions.json().items).toHaveLength(1);
});
it("enforces CSRF, mandatory ETag, unknown fields and references without partial writes",async()=>{
 const job=await create();
 expect((await app.inject({method:"PATCH",url:`/admin/api/jobs/${job.id}`,headers,payload:{name:"no-tag"}})).statusCode).toBe(428);
 expect((await app.inject({method:"PATCH",url:`/admin/api/jobs/${job.id}`,headers:{cookie:headers.cookie,"if-match":'"1"'},payload:{name:"no-csrf"}})).statusCode).toBe(403);
 expect((await app.inject({method:"PATCH",url:`/admin/api/jobs/${job.id}`,headers:{...headers,"if-match":'"1"'},payload:{actorId:"forged"}})).statusCode).toBe(400);
 const read=(await app.inject({url:`/admin/api/jobs/${job.id}`,headers})).json();expect(read.revision).toBe(1);
});
it("default-denies new resources for existing non-admin roles, applies current deny policies even to administrators",async()=>{
 const job=await create(), userId=await repos.createUser({username:`job-${newId().toLowerCase()}`,email:`job-${newId().toLowerCase()}@forge.local`,displayName:"权限测试",role:"user",dataScope:"all",orgUnitId:null,passwordHash:hashPassword("Technical!2026")});userIds.push(userId);const low=await auth(userId);
 expect((await app.inject({url:`/admin/api/jobs/${job.id}`,headers:low})).statusCode).toBe(403);
 const policy=newId();policyIds.push(policy);await execute("INSERT INTO data_policies(id,role,resource_type,actions_json,scope_type,effect) VALUES (?,'platform_admin','job_definition','[\"view\"]','all','deny')",[policy]);
 expect((await app.inject({url:`/admin/api/jobs/${job.id}`,headers})).statusCode).toBe(404);
 expect((await app.inject({url:"/admin/api/jobs",headers})).json().items).toEqual([]);
 await execute("DELETE FROM data_policies WHERE id=?",[policy]);
});
it("normalizes Key before semantic validation and rejects missing responsible users without a write",async()=>{
 const target=(await app.inject({url:"/admin/api/job-targets",headers})).json().items[0];
 const key=`trim-${newId().toLowerCase()}`;
 const create=await app.inject({method:"POST",url:"/admin/api/jobs",headers,payload:{key:` ${key} `,name:"有空白",businessType:"technical",draft:{schemaVersion:1,target:{kind:target.kind,key:target.key,version:target.version,checksum:target.checksum},inputSchema:{},outputSchema:{},nodes:[]}}});expect(create.statusCode,create.body).toBe(201);ids.push(create.json().id);expect(create.json().key).toBe(key);
 const invalid=await app.inject({method:"PATCH",url:`/admin/api/jobs/${create.json().id}`,headers:{...headers,"if-match":'"1"'},payload:{responsibleUserId:newId()}});expect(invalid.statusCode).toBe(404);
 expect((await app.inject({url:`/admin/api/jobs/${create.json().id}`,headers})).json().revision).toBe(1);
});
it("rejects malformed JSON Schema before publishing a version",async()=>{
 const job=await create();
 const patched=await app.inject({method:"PATCH",url:`/admin/api/jobs/${job.id}`,headers:{...headers,"if-match":'"1"'},payload:{draft:{...job.draft,inputSchema:{type:"banana"}}}});expect(patched.statusCode,patched.body).toBe(200);
 const publish=await app.inject({method:"POST",url:`/admin/api/jobs/${job.id}/publish`,headers:{...headers,"if-match":'"2"'},payload:{}});expect(publish.statusCode,publish.body).toBe(422);expect(publish.json().error.code).toBe("QAL-7301");
 expect((await app.inject({url:`/admin/api/jobs/${job.id}/versions`,headers})).json().items).toEqual([]);
});
it("does not return others' draft when view-all intersects a narrower manage-self policy",async()=>{
 const foreign=await create(),key=`job_reader_${newId().slice(-8).toLowerCase()}`;
 const role=await repos.createRole({key,name:"Job scope test",permissions:["job.view","job.manage"]},{expectedRevision:"system"});
 const policy1=newId(),policy2=newId();policyIds.push(policy1,policy2);
 await execute("INSERT INTO data_policies(id,role,resource_type,actions_json,scope_type,effect) VALUES (?,?,'job_definition','[\"view\"]','all','allow'),(?,?,'job_definition','[\"manage\"]','self','allow')",[policy1,key,policy2,key]);
 const id=await repos.createUser({username:`scope-${newId().toLowerCase()}`,email:`scope-${newId().toLowerCase()}@forge.local`,displayName:"Scope reader",role:key,dataScope:"all",orgUnitId:null});userIds.push(id);
 try{const h=await auth(id);const read=await app.inject({url:`/admin/api/jobs/${foreign.id}`,headers:h});expect(read.statusCode,read.body).toBe(200);expect(read.json()).not.toHaveProperty("draft");expect(read.json().allowedActions).not.toContain("manage");
 const list=(await app.inject({url:"/admin/api/jobs",headers:h})).json().items;expect(list.find((item:{id:string})=>item.id===foreign.id)).not.toHaveProperty("draft");
 expect((await app.inject({method:"PATCH",url:`/admin/api/jobs/${foreign.id}`,headers:{...h,"if-match":'"1"'},payload:{name:"unauthorized"}})).statusCode).toBe(404);
 }finally{for(const policy of [policy1,policy2])await execute("DELETE FROM data_policies WHERE id=?",[policy]);await execute("DELETE FROM auth_sessions WHERE user_id=?",[id]);await execute("DELETE FROM users WHERE id=?",[id]);userIds.splice(userIds.indexOf(id),1);await execute("DELETE FROM role_permissions WHERE role_id=?",[role]);await execute("DELETE FROM roles WHERE id=?",[role]);}
});
it("publishes independent valid input/output schemas with the same declared schema id",async()=>{
 const job=await create(),schema={$id:"https://example.invalid/technical-schema",type:"object"};
 const edit=await app.inject({method:"PATCH",url:`/admin/api/jobs/${job.id}`,headers:{...headers,"if-match":'"1"'},payload:{draft:{...job.draft,inputSchema:schema,outputSchema:schema}}});expect(edit.statusCode,edit.body).toBe(200);
 const publish=await app.inject({method:"POST",url:`/admin/api/jobs/${job.id}/publish`,headers:{...headers,"if-match":'"2"'},payload:{}});expect(publish.statusCode,publish.body).toBe(201);
});
