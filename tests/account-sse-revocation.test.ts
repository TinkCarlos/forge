import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config, hashApiKey, hashPassword, ulidWithPrefix } from "@forge/core";
import { createSession, sessionCookieValue, toPrincipal } from "@forge/identity";
import { execute, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { openSse } from "./helpers/sse-client.js";
const ROOT="01J00000000000000000000000", ADMIN="01J00000000000000000000001", AGENT="01J00000000000000000000006", VERSION="01J00000000000000000000007";
const suffix=randomBytes(5).toString("hex"), child=ulidWithPrefix("org");
const users:string[]=[], apps:string[]=[], runs:Array<{id:string;threadId:string}>=[];
let app:FastifyInstance,port:number;
beforeAll(async()=>{
  app=await buildApp({logger:false});await app.listen({host:"127.0.0.1",port:0});
  const address=app.server.address();if(!address || typeof address==="string")throw Error("TCP listener required");port=address.port;
  await execute("INSERT INTO org_units(id,parent_id,`key`,name,path) VALUES(?,?,?,?,?)",[child,ROOT,`account-sse-${suffix}`,"SSE child",`/account-sse-${suffix}/`]);
});
afterAll(async()=>{
  await app?.close();
  for(const run of runs){await execute("DELETE FROM runs WHERE id=?",[run.id]);await execute("DELETE FROM threads WHERE id=?",[run.threadId]);}
  for(const id of users){await execute("DELETE FROM audit_logs WHERE actor_id=? OR resource_id=?",[id,id]);await execute("DELETE FROM users WHERE id=?",[id]);}
  for(const id of apps){await execute("DELETE FROM audit_logs WHERE resource_id=? OR resource_id IN (SELECT id FROM api_keys WHERE app_id=?)",[id,id]);await execute("DELETE FROM api_apps WHERE id=?",[id]);}
  await execute("DELETE FROM org_units WHERE id=?",[child]);
});
async function run(subjectId:string,appId?:string){
  const threadId=await repos.createThread({agentId:AGENT,orgUnitId:ROOT,subjectType:"user",subjectId});
  const id=await repos.createRun({threadId,agentId:AGENT,agentVersionId:VERSION,orgUnitId:ROOT,subjectType:"user",subjectId,appId,input:{text:"SSE revocation fixture"},status:"running"});
  runs.push({id,threadId});await repos.addEvent(id,"run.started",{status:"running"});return id;
}
async function ends(stream:Awaited<ReturnType<typeof openSse>>){
  let timer:ReturnType<typeof setTimeout> | undefined;
  try{return await Promise.race([stream.finished,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("revoked SSE stayed connected")),2500)})]);}
  finally{if(timer)clearTimeout(timer);stream.response.destroy();}
}
for(const change of ["password","disable","sessions","scope"] as const){
  it(`an existing admin SSE ends after account ${change}`,async()=>{
    const id=await repos.createUser({email:`sse-${change}-${suffix}@forge.local`,username:`sse-${change}-${suffix}`,displayName:"SSE fixture",orgUnitId:ROOT,passwordHash:hashPassword("SSE!2026"),dataScope:"self"});users.push(id);
    const user=(await repos.getUserById(id))!;const session=await createSession(toPrincipal(user));
    const runId=await run(id);const stream=await openSse(port,`/admin/api/runs/${runId}/events`,{cookie:`forge_session=${sessionCookieValue(session)}`});await stream.waitFor(1);
    try{
      await repos.updateUser(id,change==="password"?{passwordHash:hashPassword("ChangedSSE!2026")}:change==="disable"?{status:"disabled"}:change==="sessions"?{revokeSessions:true}:{orgUnitId:child,dataScope:"org"},{expectedRevision:user.revision});
      expect(await ends(stream)).toBe("end");
    }finally{stream.response.destroy();}
  });
}
for(const change of ["key","app-scope"] as const){
  it(`an existing open SSE rechecks ${change} without charging poll requests`,async()=>{
    const appId=await repos.createApiApp({key:`sse-${change}-${suffix}`,name:"SSE app",ownerOrgUnitId:ROOT,scopes:["runs:read"],rateLimitPerMinute:1});apps.push(appId);
    const key=`fsk_${randomBytes(32).toString("base64url")}`;
    const keyId=await repos.createApiKey({appId,name:"SSE key",prefix:key.slice(0,16),keyHash:hashApiKey(key,config.API_KEY_PEPPER),scopes:["runs:read"]});
    const runId=await run(ADMIN,appId);const stream=await openSse(port,`/open/v1/runs/${runId}/events`,{authorization:`Bearer ${key}`});await stream.waitFor(1);
    try{
      let finished=false;void stream.finished.then(()=>{finished=true});await new Promise(resolve=>setTimeout(resolve,1100));expect(finished).toBe(false);
      if(change==="key")await repos.revokeApiKey(keyId,{actorId:ADMIN,orgUnitId:ROOT});
      else await repos.updateApiApp(appId,{scopes_json:"[]"},{expectedRevision:"system"});
      expect(await ends(stream)).toBe("end");
    }finally{stream.response.destroy();}
  });
}
