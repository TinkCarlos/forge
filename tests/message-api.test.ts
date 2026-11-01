import {afterAll,beforeAll,expect,it} from "vitest";
import type {FastifyInstance} from "fastify";
import {buildApp} from "../apps/api/src/app.js";
import {newId} from "@forge/core";
import {createSession,sessionCookieValue,toPrincipal} from "@forge/identity";
import {execute,query,repos} from "@forge/store";
import {fanoutMessages} from "@forge/runtime";
const channels:string[]=[],templates:string[]=[],rules:string[]=[],policies:string[]=[],runIds:string[]=[],threadIds:string[]=[];
let app:FastifyInstance,headers:Record<string,string>;
beforeAll(async()=>{app=await buildApp({logger:false});await app.ready();const session=await createSession(toPrincipal((await repos.getUserById("01J00000000000000000000001"))!));headers={cookie:`forge_session=${sessionCookieValue(session)}`,"x-csrf-token":session.csrfToken};});
afterAll(async()=>{for(const id of policies)await execute("DELETE FROM data_policies WHERE id=?",[id]);for(const id of rules)await execute("DELETE FROM message_rules WHERE id=?",[id]);for(const id of channels){const secrets=await query<{id:string}>("SELECT id FROM secrets WHERE scope_resource_type='message_channel' AND scope_id=?",[id]);const deliveries=await query<{id:string}>("SELECT id FROM message_deliveries WHERE channel_id=?",[id]);for(const row of deliveries){await execute("DELETE FROM idempotency_keys WHERE JSON_UNQUOTE(JSON_EXTRACT(response_json,'$.deliveryId'))=?",[row.id]);await execute("DELETE FROM message_delivery_attempts WHERE delivery_id=?",[row.id]);await execute("DELETE FROM audit_logs WHERE resource_id=?",[row.id]);}await execute("DELETE FROM message_deliveries WHERE channel_id=?",[id]);await execute("DELETE FROM resource_references WHERE from_type='message_channel' AND from_id=?",[id]);await execute("UPDATE message_channels SET published_version_id=NULL WHERE id=?",[id]);await execute("DELETE FROM message_channel_versions WHERE channel_id=?",[id]);await execute("DELETE FROM message_channels WHERE id=?",[id]);for(const secret of secrets){await execute("DELETE FROM secret_versions WHERE secret_id=?",[secret.id]);await execute("DELETE FROM secrets WHERE id=?",[secret.id]);}}for(const id of templates){await execute("UPDATE message_templates SET published_version_id=NULL WHERE id=?",[id]);await execute("DELETE FROM message_template_versions WHERE template_id=?",[id]);await execute("DELETE FROM message_templates WHERE id=?",[id]);}for(const id of [...channels,...templates,...rules])await execute("DELETE FROM audit_logs WHERE resource_id=?",[id]);for(const id of runIds){await execute("DELETE FROM outbox_events WHERE source_type='run' AND source_id=?",[id]);await execute("DELETE FROM runs WHERE id=?",[id]);}for(const id of threadIds)await execute("DELETE FROM threads WHERE id=?",[id]);await app?.close();});
async function create(type:"webhook"|"wecom"="webhook"){
 const response=await app.inject({method:"POST",url:"/admin/api/message-channels",headers,payload:{key:`msg-api-${newId().toLowerCase()}`,name:"技术渠道",orgUnitId:null,type,endpoint:{value:"https://example.invalid/test?key=technical-secret"},...(type==="webhook"?{signingSecret:{value:"technical-signing"}}:{})}});expect(response.statusCode,response.body).toBe(201);channels.push(response.json().id);return response.json();
}
it("creates a disabled encrypted channel without sending, masks detail/list and rejects stale edits",async()=>{
 const channel=await create();expect(channel).toMatchObject({status:"disabled",revision:1,endpointMasked:"••••••",referenceCount:0});for(const path of["/admin/api/message-channels",`/admin/api/message-channels/${channel.id}`,`/admin/api/message-channels/${channel.id}/versions`]){const response=await app.inject({url:path,headers});expect(response.statusCode,response.body).toBe(200);expect(response.body).not.toContain("technical-secret");expect(response.body).not.toContain("technical-signing");expect(response.body).not.toContain("endpoint_secret_id");}
 expect(await query("SELECT id FROM message_deliveries WHERE channel_id=?",[channel.id])).toEqual([]);
 const missing=await app.inject({method:"PATCH",url:`/admin/api/message-channels/${channel.id}`,headers,payload:{name:"x"}});expect(missing.statusCode).toBe(428);
 const changed=await app.inject({method:"PATCH",url:`/admin/api/message-channels/${channel.id}`,headers:{...headers,"if-match":'"1"'},payload:{name:"保存元数据"}});expect(changed.statusCode,changed.body).toBe(200);expect(changed.json().activeVersionId).toBe(channel.activeVersionId);
 const stale=await app.inject({method:"PATCH",url:`/admin/api/message-channels/${channel.id}`,headers:{...headers,"if-match":'"1"'},payload:{endpoint:{value:"https://example.invalid/wrong"}}});expect(stale.statusCode,stale.body).toBe(409);
});
it("explicit test requires active channel/CSRF/ETag/idempotency and records a read-back technical message",async()=>{
 const channel=await create("wecom"),url=`/admin/api/message-channels/${channel.id}/test`,key=newId(),body={eventType:"test.wecom"};
 expect((await app.inject({method:"POST",url,headers:{...headers,"if-match":'"1"',"idempotency-key":key},payload:body})).statusCode).toBe(409);
 const enable=await app.inject({method:"PATCH",url:`/admin/api/message-channels/${channel.id}`,headers:{...headers,"if-match":'"1"'},payload:{status:"active"}});expect(enable.statusCode,enable.body).toBe(200);
 expect((await app.inject({method:"POST",url,headers:{...headers,"if-match":'"2"'},payload:body})).statusCode).toBe(400);
 const sent=await app.inject({method:"POST",url,headers:{...headers,"if-match":'"2"',"idempotency-key":key},payload:body});expect(sent.statusCode,sent.body).toBe(202);
 const repeat=await app.inject({method:"POST",url,headers:{...headers,"if-match":'"2"',"idempotency-key":key},payload:body});expect(repeat.json()).toEqual(sent.json());
 const read=await app.inject({url:sent.json().statusUrl,headers});expect(read.statusCode,read.body).toBe(200);expect(read.json()).toMatchObject({status:"queued",sendCycle:1,totalAttempts:0,bodyRedacted:false,payload:{msgtype:"text",text:{content:"[TEST] Forge 渠道技术测试"}}});expect(read.body).not.toContain("fence_token");
 const cancel=await app.inject({method:"POST",url:`${sent.json().statusUrl}/cancel`,headers:{...headers,"if-match":read.headers.etag as string,"idempotency-key":newId()},payload:{reason:"技术测试结束"}});expect(cancel.statusCode,cancel.body).toBe(202);expect(cancel.json().status).toBe("cancelled");
 const metadata=await app.inject({url:`/admin/api/message-channels/${channel.id}`,headers});expect(metadata.json().referenceCount).toBe(1);
 expect((await app.inject({method:"DELETE",url:`/admin/api/message-channels/${channel.id}`,headers:{...headers,"if-match":'"2"'}})).statusCode).toBe(409);
});
it("publishes immutable templates, preserves draft/published separation and protects referenced content",async()=>{
 const created=await app.inject({method:"POST",url:"/admin/api/message-templates",headers,payload:{key:`template-${newId().toLowerCase()}`,name:"技术模板",orgUnitId:null,content:"{{taskName}} {{status}}",variables:["taskName","status"]}});expect(created.statusCode,created.body).toBe(201);const template=created.json();templates.push(template.id);expect(template.status).toBe("disabled");
 expect((await app.inject({method:"PATCH",url:`/admin/api/message-templates/${template.id}`,headers:{...headers,"if-match":'"1"'},payload:{status:"active"}})).statusCode).toBe(409);
 const publish=await app.inject({method:"POST",url:`/admin/api/message-templates/${template.id}/publish`,headers:{...headers,"if-match":'"1"'},payload:{}});expect(publish.statusCode,publish.body).toBe(201);
 const invalid=await app.inject({method:"PATCH",url:`/admin/api/message-templates/${template.id}`,headers:{...headers,"if-match":'"2"'},payload:{content:"{{arbitrary}}"}});expect(invalid.statusCode,invalid.body).toBe(422);
 const edit=await app.inject({method:"PATCH",url:`/admin/api/message-templates/${template.id}`,headers:{...headers,"if-match":'"2"'},payload:{content:"草稿 {{taskName}}",status:"active"}});expect(edit.statusCode,edit.body).toBe(200);
 const versions=await app.inject({url:`/admin/api/message-templates/${template.id}/versions`,headers});expect(versions.statusCode,versions.body).toBe(200);expect(versions.json().items[0].content).toBe("{{taskName}} {{status}}");
 const channel=await create("wecom");await app.inject({method:"PATCH",url:`/admin/api/message-channels/${channel.id}`,headers:{...headers,"if-match":'"1"'},payload:{status:"active"}});
 const rule=await app.inject({method:"POST",url:"/admin/api/message-rules",headers,payload:{key:`rule-${newId().toLowerCase()}`,name:"任务完成",eventType:"job.completed",scope:{type:"global"},channelId:channel.id,templateVersionId:publish.json().versionId,includeNestedRuns:false,status:"active"}});expect(rule.statusCode,rule.body).toBe(201);rules.push(rule.json().id);
 const duplicate=await app.inject({method:"POST",url:"/admin/api/message-rules",headers,payload:{key:`rule-${newId().toLowerCase()}`,name:"重复",eventType:"job.completed",scope:{type:"global"},channelId:channel.id,includeNestedRuns:false,status:"active"}});expect(duplicate.statusCode,duplicate.body).toBe(409);
 const removal=await app.inject({method:"DELETE",url:`/admin/api/message-templates/${template.id}`,headers:{...headers,"if-match":'"3"'}});expect(removal.statusCode,removal.body).toBe(409);
});
it("enforces deny policies on message metadata and independently redacts source payload",async()=>{
 const channel=await create("wecom");await app.inject({method:"PATCH",url:`/admin/api/message-channels/${channel.id}`,headers:{...headers,"if-match":'"1"'},payload:{status:"active"}});
 const accepted=await app.inject({method:"POST",url:`/admin/api/message-channels/${channel.id}/test`,headers:{...headers,"if-match":'"2"',"idempotency-key":newId()},payload:{eventType:"test.wecom"}});expect(accepted.statusCode,accepted.body).toBe(202);
 const policy=newId();policies.push(policy);await execute("INSERT INTO data_policies(id,role,resource_type,actions_json,scope_type,effect) VALUES(?,'platform_admin','message_channel','[\"view\"]','all','deny')",[policy]);
 const read=await app.inject({url:accepted.json().statusUrl,headers});expect(read.statusCode,read.body).toBe(200);expect(read.json()).toMatchObject({bodyRedacted:true,payload:null});expect((await app.inject({url:`/admin/api/message-channels/${channel.id}`,headers})).statusCode).toBe(404);await execute("DELETE FROM data_policies WHERE id=?",[policy]);
});

it("keeps Run notification metadata visible while a current source deny redacts its body",async()=>{
 const channel=await create("wecom");await app.inject({method:"PATCH",url:`/admin/api/message-channels/${channel.id}`,headers:{...headers,"if-match":'"1"'},payload:{status:"active"}});
 const rule=await app.inject({method:"POST",url:"/admin/api/message-rules",headers,payload:{key:`source-deny-${newId().toLowerCase()}`,name:"来源权限样本",eventType:"run.completed",scope:{type:"global"},channelId:channel.id,includeNestedRuns:false,status:"active"}});expect(rule.statusCode,rule.body).toBe(201);rules.push(rule.json().id);
 const agent=(await query<{id:string;published_version_id:string}>("SELECT id,published_version_id FROM agents WHERE status='active' AND published_version_id IS NOT NULL AND deleted_at IS NULL LIMIT 1"))[0]!;
 const thread=await repos.createThread({agentId:agent.id,orgUnitId:null,subjectType:"user",subjectId:"01J00000000000000000000001"});threadIds.push(thread);const run=await repos.createRun({threadId:thread,agentId:agent.id,agentVersionId:agent.published_version_id,subjectType:"user",subjectId:"01J00000000000000000000001",input:{text:"technical"}});runIds.push(run);await repos.updateRun(run,{status:"succeeded"});await fanoutMessages();
 const delivery=(await query<{id:string}>("SELECT id FROM message_deliveries WHERE event_id=? AND channel_id=?",[`evt_${run}`,channel.id]))[0]!;const path=`/admin/api/message-deliveries/${delivery.id}`;expect((await app.inject({url:path,headers})).json().bodyRedacted).toBe(false);
 const policy=newId();policies.push(policy);await execute("INSERT INTO data_policies(id,role,resource_type,actions_json,scope_type,effect) VALUES(?,'platform_admin','run','[\"view\"]','all','deny')",[policy]);
 try{const response=await app.inject({url:path,headers});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({payload:null,bodyRedacted:true});}finally{await execute("DELETE FROM data_policies WHERE id=?",[policy]);}
});

it("filters adjacent creation windows with an inclusive start and exclusive end, including alias cursor compatibility",async()=>{
 const channel=await create("wecom"),id=channel.id;
 expect((await app.inject({method:"PATCH",url:`/admin/api/message-channels/${id}`,headers:{...headers,"if-match":'"1"'},payload:{status:"active"}})).statusCode).toBe(200);
 const ids:string[]=[];
 for(let index=0;index<3;index++){
  const response=await app.inject({method:"POST",url:`/admin/api/message-channels/${id}/test`,headers:{...headers,"if-match":'"2"',"idempotency-key":newId()},payload:{eventType:"test.wecom"}});expect(response.statusCode,response.body).toBe(202);ids.push(response.json().deliveryId);
  await execute("UPDATE message_deliveries SET created_at=? WHERE id=?",[new Date(Date.UTC(2026,10,1,0,0,0,index)),ids[index]]);
 }
 const read=(query:Record<string,string>)=>app.inject({url:"/admin/api/message-deliveries?"+new URLSearchParams({channelId:id,...query}),headers});
 const first=await read({createdFrom:"2026-11-01T00:00:00Z",createdBefore:"2026-11-01T00:00:00.001Z"});expect(first.statusCode,first.body).toBe(200);expect(first.json().items.map((row:{id:string})=>row.id)).toEqual([ids[0]]);
 const second=await read({createdFrom:"2026-11-01T08:00:00.001+08:00",createdBefore:"2026-11-01T08:00:00.003+08:00"});expect(second.statusCode,second.body).toBe(200);expect(second.json().items.map((row:{id:string})=>row.id)).toEqual([ids[2],ids[1]]);
 const legacy=await read({from:"2026-11-01T00:00:00Z",to:"2026-11-01T00:00:00.001Z"});expect(legacy.json().items.map((row:{id:string})=>row.id)).toEqual([ids[0]]);
 expect((await read({createdFrom:"2026-11-01T00:00:00Z",from:"2026-11-01T00:00:00.001Z"})).statusCode).toBe(400);
 const page=await read({from:"2026-11-01T00:00:00Z",to:"2026-11-01T00:00:00.003Z",limit:"1"});expect(page.json().nextCursor).toBeTruthy();
 const next=await read({createdFrom:"2026-11-01T08:00:00+08:00",createdBefore:"2026-11-01T08:00:00.003+08:00",limit:"1",cursor:page.json().nextCursor});expect(next.statusCode,next.body).toBe(200);expect(next.json().items.map((row:{id:string})=>row.id)).toEqual([ids[1]]);
});
