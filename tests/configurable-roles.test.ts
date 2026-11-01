import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { PERMISSION_CATALOG, revisionTag, hashPassword, readAuthorization } from "@forge/core";
import { createSession, sessionCookieValue, toPrincipal, mapRoles } from "@forge/identity";
import { execute, pool, query, repos } from "@forge/store";
import { resolveScheduleIdentity } from "@forge/runtime";
import { lockAccounts } from "../packages/store/src/account-write.js";
import { buildApp } from "../apps/api/src/app.js";

const suffix=randomBytes(5).toString("hex"),root="01J00000000000000000000000",adminId="01J00000000000000000000001";
const roleIds:string[]=[],userIds:string[]=[],serviceIds:string[]=[];
const agentIds:string[]=[],pluginIds:string[]=[];
let app:FastifyInstance,headers:Record<string,string>;
async function cookie(id:string){const session=await createSession(toPrincipal((await repos.getUserById(id))!));return{cookie:`forge_session=${sessionCookieValue(session)}`,"x-csrf-token":session.csrfToken};}
async function createRole(name:string,permissions:string[]){const response=await app.inject({method:"POST",url:"/admin/api/roles",headers,payload:{key:`r_${name}_${suffix}`,name,permissions}});expect(response.statusCode,response.body).toBe(200);roleIds.push(response.json().id);return(await repos.getRole(response.json().id))!;}
async function createUser(name:string,role:string,extra={}){const id=await repos.createUser({email:`role-${name}-${suffix}@forge.local`,username:`role-${name}-${suffix}`,displayName:name,role,dataScope:"all",orgUnitId:root,passwordHash:hashPassword("RolesTest!2026"),...extra});userIds.push(id);return id;}
async function roleHeaders(id:string,h=headers){return{...h,"if-match":revisionTag((await repos.getRole(id))!.revision)};}
async function userHeaders(id:string,h=headers){return{...h,"if-match":revisionTag((await repos.getUserById(id))!.revision)};}
beforeAll(async()=>{app=await buildApp({logger:false});await app.ready();headers=await cookie(adminId);});
afterAll(async()=>{
  for(const id of pluginIds)await execute("DELETE FROM plugins WHERE id=?",[id]);
  for(const id of agentIds){await execute("UPDATE agents SET published_version_id=NULL,latest_version_id=NULL WHERE id=?",[id]);await execute("DELETE FROM agent_versions WHERE agent_id=?",[id]);await execute("DELETE FROM agents WHERE id=?",[id]);}
  await execute("DELETE FROM oidc_role_mappings WHERE agent_role_code LIKE ?",[`roles-%-${suffix}`]);
  for(const id of userIds){await execute("DELETE FROM role_bindings WHERE principal_id=?",[id]);await execute("DELETE FROM users WHERE id=?",[id]);}
  for(const id of serviceIds){await execute("DELETE FROM role_bindings WHERE principal_id=?",[id]);await execute("DELETE FROM service_accounts WHERE id=?",[id]);}
  for(const id of roleIds){await execute("DELETE FROM role_bindings WHERE role_id=?",[id]);await execute("DELETE FROM role_permissions WHERE role_id=?",[id]);await execute("DELETE FROM roles WHERE id=?",[id]);}
  for(const id of [...agentIds,...roleIds,...userIds,...serviceIds])await execute("DELETE FROM audit_logs WHERE resource_id=? OR actor_id=?",[id,id]);
  await app?.close();
});

it("custom primary roles grant exactly configured permissions, live edits revoke the existing session",async()=>{
  const role=await createRole("reader",["agent.view"]),id=await createUser("reader",role.key),h=await cookie(id);
  expect((await app.inject({url:"/auth/session",headers:h})).json().permissions).toEqual(["agent.view"]);
  expect((await app.inject({url:"/admin/api/agents",headers:h})).statusCode).toBe(200);
  const dashboard=(await app.inject({url:"/admin/api/dashboard",headers:h})).json();
  expect(dashboard).toHaveProperty("agents");expect(dashboard).not.toHaveProperty("runsToday");expect(dashboard).not.toHaveProperty("runsByStatus");expect(dashboard).not.toHaveProperty("pendingApprovals");
  expect((await app.inject({method:"POST",url:"/admin/api/agents/01J00000000000000000000006/run",headers:h,payload:{text:"must not run"}})).statusCode).toBe(403);
  expect((await app.inject({url:"/admin/api/runs",headers:h})).statusCode).toBe(403);
  const changed=await app.inject({method:"PATCH",url:`/admin/api/roles/${role.id}`,headers:await roleHeaders(role.id),payload:{permissions:[]}});expect(changed.statusCode,changed.body).toBe(200);
  expect((await app.inject({url:"/auth/session",headers:h})).json().permissions).toEqual([]);
  expect((await app.inject({url:"/admin/api/agents",headers:h})).statusCode).toBe(403);
});

it("multiple roles union without duplicates, disabled grants persist but contribute nothing",async()=>{
  const view=await createRole("multi_view",["agent.view"]),run=await createRole("multi_run",["agent.view","agent.run"]);
  const created=await app.inject({method:"POST",url:"/admin/api/users",headers,payload:{email:`multi-${suffix}@forge.local`,role:view.key,additionalRoleIds:[run.id]}});expect(created.statusCode,created.body).toBe(200);
  const id=created.json().id as string;userIds.push(id);const h=await cookie(id);
  expect(new Set((await app.inject({url:"/auth/session",headers:h})).json().permissions)).toEqual(new Set(["agent.view","agent.run"]));
  expect((await app.inject({url:`/admin/api/users/${id}`,headers})).json()).toMatchObject({additional_role_ids:[run.id]});
  expect((await app.inject({method:"PATCH",url:`/admin/api/roles/${run.id}`,headers:await roleHeaders(run.id),payload:{status:"disabled"}})).statusCode).toBe(200);
  expect((await app.inject({url:"/auth/session",headers:h})).json().permissions).toEqual(["agent.view"]);
  expect((await app.inject({method:"PATCH",url:`/admin/api/users/${id}`,headers:await userHeaders(id),payload:{displayName:"Keep disabled grant"}})).statusCode).toBe(200);
  expect((await app.inject({url:`/admin/api/users/${id}`,headers})).json().additional_role_ids).toEqual([run.id]);
  const other=await createUser("disabled_binding",view.key);
  expect((await app.inject({method:"PATCH",url:`/admin/api/users/${other}`,headers:await userHeaders(other),payload:{additionalRoleIds:[run.id]}})).statusCode).toBe(400);
  expect((await app.inject({method:"PATCH",url:`/admin/api/roles/${run.id}`,headers:await roleHeaders(run.id),payload:{status:"active"}})).statusCode).toBe(200);
  expect(new Set((await app.inject({url:"/auth/session",headers:h})).json().permissions)).toEqual(new Set(["agent.view","agent.run"]));
});

it("a delegated manager cannot create or take over higher configured permissions, even when disabled",async()=>{
  const low=await createRole("delegate",["role.view","role.manage","user.view","user.manage","sso.manage"]),high=await createRole("high",["agent.run"]);
  const actor=await createUser("delegate",low.key),h=await cookie(actor),target=await createUser("high",high.key);
  expect((await app.inject({method:"PATCH",url:`/admin/api/roles/${high.id}`,headers:await roleHeaders(high.id),payload:{status:"disabled"}})).statusCode).toBe(200);
  for(const path of ["", "/copy"]){const response=await app.inject({method:path?"POST":"PATCH",url:`/admin/api/roles/${high.id}${path}`,headers:await roleHeaders(high.id,h),payload:path?{key:`copy_${suffix}`,name:"no"}:{permissions:[]}});expect(response.statusCode,response.body).toBe(403);}
  expect((await app.inject({method:"POST",url:"/admin/api/roles",headers:h,payload:{key:`excess_${suffix}`,name:"no",permissions:["agent.run"]}})).statusCode).toBe(403);
  expect((await app.inject({method:"POST",url:`/admin/api/users/${target}/password`,headers:await userHeaders(target,h),payload:{password:"Takeover!2026"}})).statusCode).toBe(403);
  expect((await app.inject({method:"POST",url:"/admin/api/role-mappings",headers:h,payload:{agentRoleCode:`roles-no-${suffix}`,localRole:"platform_admin"}})).statusCode).toBe(403);
  expect((await repos.getRole(high.id))!.permissions_json).toEqual(["agent.run"]);
});

it("CAS, protected builtin roles, copy expansion and referenced deletion have no partial writes",async()=>{
  const role=await createRole("cas",["agent.view"]),same=await roleHeaders(role.id);
  const results=await Promise.all(["One","Two"].map(name=>app.inject({method:"PATCH",url:`/admin/api/roles/${role.id}`,headers:same,payload:{name}})));
  expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
  expect((await app.inject({method:"PATCH",url:`/admin/api/roles/${role.id}`,headers,payload:{name:"no tag"}})).statusCode).toBe(428);
  const copy=await app.inject({method:"POST",url:`/admin/api/roles/${role.id}/copy`,headers:await roleHeaders(role.id),payload:{key:`copied_${suffix}`,name:"Copied"}});expect(copy.statusCode,copy.body).toBe(200);roleIds.push(copy.json().id);
  expect((await repos.getRole(copy.json().id))!.permissions_json).toEqual(["agent.view"]);
  const platform=(await repos.getRoleByKey("platform_admin"))!;
  for(const method of ["PATCH","DELETE"] as const)expect((await app.inject({method,url:`/admin/api/roles/${platform.id}`,headers:await roleHeaders(platform.id),payload:method==="PATCH"?{status:"disabled"}:{}})).statusCode).toBe(403);
  const expanded=await app.inject({method:"POST",url:`/admin/api/roles/${platform.id}/copy`,headers:await roleHeaders(platform.id),payload:{key:`expanded_${suffix}`,name:"Explicit permissions"}});expect(expanded.statusCode,expanded.body).toBe(200);roleIds.push(expanded.json().id);
  expect((await repos.getRole(expanded.json().id))!.permissions_json).not.toContain("*");
  const builtin=(await repos.getRoleByKey("builder"))!;
  expect((await app.inject({method:"DELETE",url:`/admin/api/roles/${builtin.id}`,headers:await roleHeaders(builtin.id)})).statusCode).toBe(409);
  await createUser("referenced",role.key);
  expect((await app.inject({method:"DELETE",url:`/admin/api/roles/${role.id}`,headers:await roleHeaders(role.id)})).statusCode).toBe(409);
  expect((await app.inject({method:"DELETE",url:`/admin/api/roles/${copy.json().id}`,headers:await roleHeaders(copy.json().id)})).statusCode).toBe(200);
  expect(await repos.getRole(copy.json().id)).toBeNull();
});

it("custom SSO role mappings are validated, select active roles, and do not mutate existing grants",async()=>{
  const role=await createRole("sso",["agent.view"]),code=`roles-custom-${suffix}`;
  const response=await app.inject({method:"POST",url:"/admin/api/role-mappings",headers,payload:{agentRoleCode:code,localRole:role.key}});expect(response.statusCode,response.body).toBe(200);
  expect(await mapRoles([{code,name:""}])).toBe(role.key);
  expect((await app.inject({method:"DELETE",url:`/admin/api/roles/${role.id}`,headers:await roleHeaders(role.id)})).statusCode).toBe(409);
  expect((await app.inject({method:"PATCH",url:`/admin/api/roles/${role.id}`,headers:await roleHeaders(role.id),payload:{status:"disabled"}})).statusCode).toBe(200);
  expect(await mapRoles([{code,name:""}])).not.toBe(role.key);
});

it("service account roles use the same union and revocation pauses scheduled execution",async()=>{
  const role=await createRole("service",["agent.run"]);
  const response=await app.inject({method:"POST",url:"/admin/api/service-accounts",headers,payload:{key:`role-svc-${suffix}`,name:"Role service",role:role.key}});expect(response.statusCode,response.body).toBe(200);
  const id=response.json().id as string;serviceIds.push(id);
  const schedule={service_account_id:id};expect((await resolveScheduleIdentity(schedule)).permissions).toEqual(["agent.run"]);
  expect((await app.inject({method:"PATCH",url:`/admin/api/roles/${role.id}`,headers:await roleHeaders(role.id),payload:{permissions:[]}})).statusCode).toBe(200);
  await expect(resolveScheduleIdentity(schedule)).rejects.toMatchObject({code:"SCD-4801"});
  const stored=await repos.getServiceAccount(id);expect(readAuthorization(stored!.authorization_json).permissions).toEqual([]);
});

it("rejects malformed permissions, duplicate bindings and platform-admin additional grants",async()=>{
  const role=await createRole("input",[]),id=await createUser("input",role.key),platform=(await repos.getRoleByKey("platform_admin"))!;
  for(const permissions of [["*"],["unknown.permission"],["agent.view","agent.view"]])expect((await app.inject({method:"PATCH",url:`/admin/api/roles/${role.id}`,headers:await roleHeaders(role.id),payload:{permissions}})).statusCode).toBe(400);
  for(const additionalRoleIds of [[role.id],[platform.id],[platform.id,platform.id]])expect((await app.inject({method:"PATCH",url:`/admin/api/users/${id}`,headers:await userHeaders(id),payload:{additionalRoleIds}})).statusCode).toBe(400);
  expect((await query("SELECT * FROM role_bindings WHERE principal_id=?",[id])).length).toBe(0);
});

it("copying a platform template expands explicit permissions without granting protected identities",async()=>{
  const all=await createRole("concrete_all",PERMISSION_CATALOG.map(item=>item.key)),actor=await createUser("concrete_all",all.key),h=await cookie(actor);
  const platform=(await repos.getRoleByKey("platform_admin"))!;
  expect((await app.inject({url:`/admin/api/roles/${platform.id}`,headers:h})).json()).toMatchObject({can_copy:true,can_manage:false});
  const copy=await app.inject({method:"POST",url:`/admin/api/roles/${platform.id}/copy`,headers:await roleHeaders(platform.id,h),payload:{key:`concrete_copy_${suffix}`,name:"Concrete copy"}});
  expect(copy.statusCode,copy.body).toBe(200);roleIds.push(copy.json().id);
  expect((await repos.getRole(copy.json().id))!.permissions_json).not.toContain("*");
  for(const localRole of ["platform_admin","org_admin"]){
    const denied=await app.inject({method:"POST",url:"/admin/api/role-mappings",headers:h,payload:{agentRoleCode:`roles-no-${localRole}-${suffix}`,localRole}});
    expect(denied.statusCode,denied.body).toBe(403);
  }
  const orgAdmin=(await repos.getRoleByKey("org_admin"))!;
  const target=await createUser("protected_extra","user",{additionalRoleIds:[orgAdmin.id]});
  expect((await app.inject({method:"POST",url:`/admin/api/users/${target}/password`,headers:await userHeaders(target,h),payload:{password:"Takeover!2026"}})).statusCode).toBe(403);
});

it("mapping or role changes after SSO selection reject the stale first grant atomically",async()=>{
  const role=await createRole("jit_fence",["agent.view"]),code=`roles-fence-${suffix}`;
  await repos.upsertRoleMapping(code,"",role.key,{expectedRevision:"system"});
  const snapshot=await repos.getSsoRoleSnapshot(),selected=await mapRoles([{code,name:""}],snapshot);
  expect(selected).toBe(role.key);
  await repos.upsertRoleMapping(code,"","user",{expectedRevision:"system"});
  const username=`stale-jit-${suffix}`;
  await expect(repos.createUser({username,email:`${username}@forge.local`,displayName:username,role:selected!,idpSubject:username,idpIssuer:"https://idp.roles.test"},{expectedRevision:"system",roleMappingRevision:snapshot.revision})).rejects.toMatchObject({code:"SSO-1201"});
  expect(await repos.getUserByLogin(username)).toBeNull();
  const current=await repos.getSsoRoleSnapshot();
  await repos.updateRole(role.id,{name:"Changed role"},{expectedRevision:role.revision});
  await expect(repos.createUser({username,email:`${username}@forge.local`,displayName:username,role:"user"},{expectedRevision:"system",roleMappingRevision:current.revision})).rejects.toMatchObject({code:"SSO-1201"});
  expect(await repos.getUserByLogin(username)).toBeNull();
});

it("an already authorized request cannot grant after its role was revoked while waiting for the account lock",async()=>{
  const role=await createRole("queued_actor",["user.manage","user.view","agent.view"]),actor=await createUser("queued_actor",role.key),h=await cookie(actor);
  const target=await createRole("queued_target",["agent.view"]);
  const conn=await pool.getConnection();await conn.beginTransaction();await lockAccounts(conn);
  const original=repos.createUser;let entered!:()=>void;const barrier=new Promise<void>(resolve=>{entered=resolve;});
  const spy=vi.spyOn(repos,"createUser").mockImplementation(async(...args)=>{entered();return original(...args);});
  const email=`queued-${suffix}@forge.local`;
  try{
    const pending=app.inject({method:"POST",url:"/admin/api/users",headers:h,payload:{email,role:target.key}}).then(response=>response);
    await barrier;
    await conn.execute("DELETE FROM role_permissions WHERE role_id=? AND permission_key='user.manage'",[role.id]);
    await conn.execute("UPDATE roles SET revision=revision+1 WHERE id=?",[role.id]);
    await conn.commit();
    const result=await pending;expect(result.statusCode,result.body).toBe(403);
    expect(await repos.getUserByLogin(email)).toBeNull();
  }finally{spy.mockRestore();await conn.rollback();conn.release();}
});

it("creating a first published Agent version requires publish permission, while draft creation stays available",async()=>{
  const role=await createRole("create_only",["agent.manage"]),actor=await createUser("create_only",role.key),h=await cookie(actor),key=`role-create-${suffix}`;
  const denied=await app.inject({method:"POST",url:"/admin/api/agents",headers:h,payload:{key,name:"Publish denied",publish:true}});
  expect(denied.statusCode,denied.body).toBe(403);expect(await repos.getAgentByKey(key)).toBeNull();
  const draft=await app.inject({method:"POST",url:"/admin/api/agents",headers:h,payload:{key,name:"Draft allowed",publish:false}});
  expect(draft.statusCode,draft.body).toBe(200);agentIds.push(draft.json().id);
  expect((await repos.getAgent(draft.json().id))!.published_version_id).toBeNull();expect((await repos.getAgentVersion(draft.json().versionId))!.status).toBe("draft");
});

it("reset restores the builtin permission template while preserving metadata",async()=>{
  const role=(await repos.getRoleByKey("builder"))!,saved={name:role.name,description:role.description,status:role.status,permissions:role.permissions_json};
  try{
    const changed=await app.inject({method:"PATCH",url:`/admin/api/roles/${role.id}`,headers:await roleHeaders(role.id),payload:{name:"Temporary builder",permissions:[]}});expect(changed.statusCode,changed.body).toBe(200);
    const reset=await app.inject({method:"POST",url:`/admin/api/roles/${role.id}/reset`,headers:await roleHeaders(role.id)});expect(reset.statusCode,reset.body).toBe(200);
    const current=(await repos.getRole(role.id))!;expect(current.name).toBe("Temporary builder");expect(new Set(current.permissions_json)).toEqual(new Set(saved.permissions));
  }finally{await repos.updateRole(role.id,saved,{expectedRevision:"system"});}
});

it("audit failure rolls role permissions, metadata and revision back together",async()=>{
  const role=await createRole("audit_rollback",["agent.view"]),trigger=`roles_fail_${suffix}`;
  await query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_logs FOR EACH ROW BEGIN IF NEW.resource_id='${role.id}' AND NEW.action='role.update' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='role audit probe'; END IF; END`);
  try{
    const response=await app.inject({method:"PATCH",url:`/admin/api/roles/${role.id}`,headers:await roleHeaders(role.id),payload:{name:"Must roll back",permissions:["agent.run"]}});expect(response.statusCode).toBe(500);
    const after=(await repos.getRole(role.id))!;expect(after.revision).toBe(role.revision);expect(after.name).toBe(role.name);expect(after.permissions_json).toEqual(["agent.view"]);
  }finally{await query(`DROP TRIGGER ${trigger}`);}
});

it("installing an Agent package never publishes through plugin.install-only authorization",async()=>{
  const role=await createRole("installer",["plugin.install"]),actor=await createUser("installer",role.key),h=await cookie(actor),key=`role-pack-agent-${suffix}`;
  const result=await app.inject({method:"POST",url:"/admin/api/plugins/install",headers:h,payload:{key:`com.test.roles.${suffix}`,version:"1.0.0",type:"mixed",name:"Role package",resources:{agents:[{key,name:"Pack Agent",version:"1.0.0",instructions:"Test",spec:{model:{provider:"mock",model:"mock-1"}}}]}}});
  expect(result.statusCode,result.body).toBe(200);pluginIds.push(result.json().id);
  const agent=(await repos.getAgentByKey(key))!;agentIds.push(agent.id);expect(agent.published_version_id).toBeNull();
  const versions=await repos.listAgentVersions(agent.id);expect(versions).toHaveLength(1);expect(versions[0]!.status).toBe("draft");
});

it("self-only account managers may edit their own profile without changing department or scope",async()=>{
  const role=await createRole("self_manager",["user.view","user.manage"]),id=await createUser("self_manager",role.key,{dataScope:"self"}),h=await cookie(id);
  const saved=await app.inject({method:"PATCH",url:`/admin/api/users/${id}`,headers:await userHeaders(id,h),payload:{displayName:"Own profile updated"}});
  expect(saved.statusCode,saved.body).toBe(200);expect((await app.inject({url:"/auth/session",headers:h})).json().user.name).toBe("Own profile updated");
  for(const payload of [{orgUnitId:null},{dataScope:"all"}])expect((await app.inject({method:"PATCH",url:`/admin/api/users/${id}`,headers:await userHeaders(id,h),payload})).statusCode).toBe(403);
  const other=await createUser("self_other",role.key,{dataScope:"self"});
  expect((await app.inject({method:"PATCH",url:`/admin/api/users/${other}`,headers:await userHeaders(other,h),payload:{displayName:"no"}})).statusCode).toBe(404);
});

it("locked organization authorization reuses its transaction connection when the pool is saturated",async()=>{
  const actor=await createUser("pool_org_manager","org_admin",{dataScope:"org"}),target=await createUser("pool_target","user",{dataScope:"self"}),h=await cookie(actor),tag=await userHeaders(target,h);
  const held:Array<Awaited<ReturnType<typeof pool.getConnection>>>=[];let queued=0;
  const enqueue=()=>{queued++;held.pop()?.release();};
  const original=repos.updateUser;
  const spy=vi.spyOn(repos,"updateUser").mockImplementation(async(...args)=>{
    held.push(...await Promise.all(Array.from({length:19},()=>pool.getConnection())));
    pool.on("enqueue",enqueue);
    const watchdog=setTimeout(()=>{while(held.length)held.pop()!.release();},10_000);
    try{return await original(...args);}finally{clearTimeout(watchdog);pool.removeListener("enqueue",enqueue);while(held.length)held.pop()!.release();}
  });
  try{
    const result=await app.inject({method:"PATCH",url:`/admin/api/users/${target}`,headers:tag,payload:{displayName:"No nested pool read"}});
    expect(result.statusCode,result.body).toBe(200);expect(queued).toBe(0);
  }finally{spy.mockRestore();pool.removeListener("enqueue",enqueue);while(held.length)held.pop()!.release();}
});
