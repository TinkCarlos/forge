import {wecomTargetIdentity} from "@forge/contracts";
import {afterAll,expect,it} from "vitest";
import {createHmac} from "node:crypto";
import {newId,sha256,type QueryFilter,type safeFetch} from "@forge/core";
import {messageConfigRepo,messageDeliveryRepo,repos,query,execute,type MessageWrite,type ClaimedMessage} from "@forge/store";
import {deliverMessages} from "@forge/runtime";
import {wecomTextBody} from "../packages/runtime/src/message-protocol.js";
const all:QueryFilter={allow:[{type:"all"}],deny:[],ceiling:{type:"all"}},channels:string[]=[],keys:string[]=[];
const write:MessageWrite={actor:{type:"user",id:"01J00000000000000000000001"},authorize:async()=>{}};
afterAll(async()=>{for(const id of channels){const secrets=await query<{id:string}>("SELECT id FROM secrets WHERE scope_resource_type='message_channel' AND scope_id=?",[id]);const deliveries=await query<{id:string}>("SELECT id FROM message_deliveries WHERE channel_id=?",[id]);for(const row of deliveries){await execute("DELETE FROM idempotency_keys WHERE JSON_UNQUOTE(JSON_EXTRACT(response_json,'$.deliveryId'))=?",[row.id]);await execute("DELETE FROM message_delivery_attempts WHERE delivery_id=?",[row.id]);await execute("DELETE FROM audit_logs WHERE resource_id=?",[row.id]);}await execute("DELETE FROM message_deliveries WHERE channel_id=?",[id]);await execute("DELETE FROM resource_references WHERE from_type='message_channel' AND from_id=?",[id]);await execute("UPDATE message_channels SET published_version_id=NULL WHERE id=?",[id]);await execute("DELETE FROM message_channel_versions WHERE channel_id=?",[id]);await execute("DELETE FROM message_channels WHERE id=?",[id]);await execute("DELETE FROM audit_logs WHERE resource_id=?",[id]);for(const secret of secrets){await execute("DELETE FROM secret_versions WHERE secret_id=?",[secret.id]);await execute("DELETE FROM secrets WHERE id=?",[secret.id]);}}for(const key of keys)await execute("DELETE FROM idempotency_keys WHERE idempotency_key=?",[key]);});
async function channel(type:"webhook"|"wecom"="webhook",endpoint?:string){
 const row=await messageConfigRepo.createMessageChannel({key:`delivery-${newId().toLowerCase()}`,name:"技术投递样本",type,endpoint:{value:endpoint??`https://example.invalid/technical/${newId()}`},...(type==="webhook"?{signingSecret:{value:"technical-signing"}}:{})},all,write);channels.push(row.id);return messageConfigRepo.updateMessageChannel(row.id,{status:"active"},row.revision,all,write);
}
async function enqueue(row:Awaited<ReturnType<typeof channel>>,key=newId()){
 const input={channelId:row.id,expectedRevision:row.revision,idempotencyKey:key,eventType:`test.${row.type}` as "test.webhook"|"test.wecom"};
 const result=await messageDeliveryRepo.enqueueTest(input,all,write,async()=>row.type==="wecom"?wecomTextBody("[TEST] 技术消息",{}):JSON.stringify({type:"test.webhook",test:true,data:{summary:"technical"}}));return{...result,input};
}
async function submit(claim:ClaimedMessage,authorize:Parameters<typeof messageDeliveryRepo.submit>[1]){
 const slot=`endpoint-version:${claim.version.id}`,url=(await repos.resolveCredentialValues(claim.channel.credential_owner_type,claim.channel.credential_owner_id,{[slot]:claim.version.endpoint_secret_id}))[slot]!;
 return messageDeliveryRepo.submit(claim,authorize,claim.channel.type==="wecom"?sha256(wecomTargetIdentity(url)!):null);
}
const success:typeof safeFetch=async()=>new Response('{"errcode":0}',{status:200});
it("sends the exact frozen webhook bytes and signature; automatic retry retains identity and appends attempts",async()=>{
 const row=await channel(),queued=await enqueue(row);let calls=0;const bodies:string[]=[];
 const transport:typeof safeFetch=async(url,init)=>{expect(String(url)).toContain("example.invalid/technical/");calls++;const body=String(init?.body),headers=new Headers(init?.headers);bodies.push(body);const t=headers.get("X-Forge-Timestamp")!;expect(headers.get("X-Forge-Signature")).toBe(`t=${t},v1=${createHmac("sha256","technical-signing").update(`${t}.${body}`).digest("hex")}`);expect(headers.get("X-Forge-Delivery-Id")).toBe(queued.deliveryId);return new Response("ignored",{status:calls===1?503:200});};
 await deliverMessages("test-delivery",transport);expect(await messageDeliveryRepo.getDelivery(queued.deliveryId,all)).toMatchObject({status:"retry_wait",total_attempts:1,cycle_attempts:1});await execute("UPDATE message_deliveries SET next_attempt_at=UTC_TIMESTAMP(3) WHERE id=?",[queued.deliveryId]);await deliverMessages("test-delivery",transport);
 expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);const complete=(await messageDeliveryRepo.getDelivery(queued.deliveryId,all))!;expect(complete).toMatchObject({status:"delivered",total_attempts:2,send_cycle:1});expect(complete.first_delivered_at).not.toBeNull();expect((await messageDeliveryRepo.listAttempts(queued.deliveryId,all)).items.map(a=>a.status)).toEqual(["succeeded","failed"]);
});
it("makes WeCom transport ambiguity unknown without auto-retry and requires duplicate acknowledgment for a new cycle",async()=>{
 const row=await channel("wecom"),queued=await enqueue(row);await deliverMessages("test-delivery",async()=>{throw Error("response lost")});const unknown=(await messageDeliveryRepo.getDelivery(queued.deliveryId,all))!;expect(unknown).toMatchObject({status:"unknown",next_attempt_at:null,total_attempts:1});
 await expect(messageDeliveryRepo.control(unknown.id,"retry",{reason:"核实后补发"},unknown.state_revision,newId(),all,{actor:write.actor,authorize:async()=>{}})).rejects.toMatchObject({code:"MSG-7206"});
 const retried=await messageDeliveryRepo.control(unknown.id,"retry",{reason:"核实后补发",acknowledgeDuplicate:true},unknown.state_revision,newId(),all,{actor:write.actor,authorize:async()=>{}});expect(retried).toMatchObject({sendCycle:2,status:"queued"});await deliverMessages("test-delivery",success);expect(await messageDeliveryRepo.getDelivery(unknown.id,all)).toMatchObject({status:"delivered",send_cycle:2,total_attempts:2});expect((await messageDeliveryRepo.listAttempts(unknown.id,all)).items).toHaveLength(2);
});
it("stops dispatch authorization after disable and never releases held history just by enabling",async()=>{
 const row=await channel(),queued=await enqueue(row),claim=(await messageDeliveryRepo.prepare(queued.deliveryId,row.id,"test-race",async()=>true))!;expect(claim).not.toBeNull();
 const disabled=await messageConfigRepo.updateMessageChannel(row.id,{status:"disabled"},row.revision,all,write);expect(await submit(claim,async()=>true)).toBe(false);expect(await messageDeliveryRepo.getDelivery(queued.deliveryId,all)).toMatchObject({status:"held",hold_reason:"channel_disabled"});await messageConfigRepo.updateMessageChannel(row.id,{status:"active"},disabled.revision,all,write);expect((await messageDeliveryRepo.due()).map(r=>r.id)).not.toContain(queued.deliveryId);
});
it("retains real in-flight success after cancel and preserves first success across explicit replay",async()=>{
 const row=await channel(),queued=await enqueue(row),claim=(await messageDeliveryRepo.prepare(queued.deliveryId,row.id,"test-race",async()=>true))!;expect(await submit(claim,async()=>true)).toBe(true);
 await messageDeliveryRepo.control(queued.deliveryId,"cancel",{reason:"停止后续重试"},claim.delivery.state_revision,newId(),all,{actor:write.actor,authorize:async()=>{}});
 await messageDeliveryRepo.complete(claim,{attemptStatus:"succeeded",deliveryStatus:"delivered",errorCode:null,responseSummary:null,retryDelayMs:null},200);
 const delivered=(await messageDeliveryRepo.getDelivery(queued.deliveryId,all))!;expect(delivered.status).toBe("delivered");const first=delivered.first_delivered_at!;
 await messageDeliveryRepo.control(queued.deliveryId,"retry",{reason:"确认重复补发",acknowledgeDuplicate:true},delivered.state_revision,newId(),all,{actor:write.actor,authorize:async()=>{}});await deliverMessages("test-delivery",success);expect((await messageDeliveryRepo.getDelivery(queued.deliveryId,all))!.first_delivered_at!.getTime()).toBe(first.getTime());
});
it("recovers submitted WeCom leases as unknown and records late evidence without changing a newer cycle",async()=>{
 const row=await channel("wecom"),queued=await enqueue(row),claim=(await messageDeliveryRepo.prepare(queued.deliveryId,row.id,"test-dead",async()=>true))!;expect(await submit(claim,async()=>true)).toBe(true);await execute("UPDATE message_deliveries SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?",[queued.deliveryId]);await deliverMessages("test-recovery",success);const unknown=(await messageDeliveryRepo.getDelivery(queued.deliveryId,all))!;expect(unknown.status).toBe("unknown");
 await messageDeliveryRepo.control(queued.deliveryId,"retry",{reason:"重复风险已确认",acknowledgeDuplicate:true},unknown.state_revision,newId(),all,{actor:write.actor,authorize:async()=>{}});
 await messageDeliveryRepo.complete(claim,{attemptStatus:"succeeded",deliveryStatus:"delivered",errorCode:null,responseSummary:null,retryDelayMs:null},200);expect(await messageDeliveryRepo.getDelivery(queued.deliveryId,all)).toMatchObject({status:"queued",send_cycle:2});expect((await messageDeliveryRepo.listAttempts(queued.deliveryId,all)).items[0]!.status).toBe("succeeded");
 // Keep this technical sample from being consumed by subsequent cases.
 const current=(await messageDeliveryRepo.getDelivery(queued.deliveryId,all))!;await messageDeliveryRepo.control(current.id,"cancel",{reason:"测试结束"},current.state_revision,newId(),all,{actor:write.actor,authorize:async()=>{}});
});
it("deduplicates a lost test response and rejects changed content under the same key",async()=>{
 const row=await channel(),key=newId(),first=await enqueue(row,key),second=await enqueue(row,key);expect(second.deliveryId).toBe(first.deliveryId);expect((await query("SELECT id FROM message_deliveries WHERE channel_id=?",[row.id]))).toHaveLength(1);await expect(messageDeliveryRepo.enqueueTest({...first.input,eventType:"test.wecom"},all,write,async()=>"{}")).rejects.toMatchObject({code:"MSG-7206"});await deliverMessages("test-delivery",success);
});
it("holds old destinations after address changes, rejects missing historical confirmation and purged payload replay",async()=>{
 const row=await channel(),queued=await enqueue(row);await messageConfigRepo.updateMessageChannel(row.id,{endpoint:{value:`https://example.invalid/changed/${newId()}`}},row.revision,all,write);let held=(await messageDeliveryRepo.getDelivery(queued.deliveryId,all))!;expect(held).toMatchObject({status:"held",hold_reason:"target_changed"});await expect(messageDeliveryRepo.control(held.id,"retry",{reason:"原地址补发"},held.state_revision,newId(),all,{actor:write.actor,authorize:async()=>{}})).rejects.toMatchObject({code:"MSG-7202"});
 await execute("UPDATE message_deliveries SET payload_body=NULL,payload_purged_at=UTC_TIMESTAMP(3) WHERE id=?",[held.id]);held=(await messageDeliveryRepo.getDelivery(held.id,all))!;await expect(messageDeliveryRepo.control(held.id,"retry",{reason:"原地址补发",acknowledgeHistoricalTarget:true},held.state_revision,newId(),all,{actor:write.actor,authorize:async()=>{}})).rejects.toMatchObject({code:"MSG-7203"});
});
it("does not auto-release in-flight failures after disable and re-enable",async()=>{
 const row=await channel(),queued=await enqueue(row),claim=(await messageDeliveryRepo.prepare(queued.deliveryId,row.id,"test-disable-race",async()=>true))!;expect(await submit(claim,async()=>true)).toBe(true);
 const disabled=await messageConfigRepo.updateMessageChannel(row.id,{status:"disabled"},row.revision,all,write);await messageConfigRepo.updateMessageChannel(row.id,{status:"active"},disabled.revision,all,write);
 await messageDeliveryRepo.complete(claim,{attemptStatus:"failed",deliveryStatus:"retry_wait",errorCode:"MSG-7204",responseSummary:"HTTP 503",retryDelayMs:60000},503);expect(await messageDeliveryRepo.getDelivery(queued.deliveryId,all)).toMatchObject({status:"held",hold_reason:"channel_disabled",next_attempt_at:null});
 let calls=0;await deliverMessages("test-race",async()=>{calls++;return new Response("ok")});expect(calls).toBe(0);
});
it("preserves unknown duplicate risk through cancel and later cycles",async()=>{
 const row=await channel("wecom"),queued=await enqueue(row);await deliverMessages("test-unknown",async()=>{throw Error("response lost")});const unknown=(await messageDeliveryRepo.getDelivery(queued.deliveryId,all))!;
 const canceled=await messageDeliveryRepo.control(unknown.id,"cancel",{reason:"停止后续"},unknown.state_revision,newId(),all,{actor:write.actor,authorize:async()=>{}});expect(canceled.status).toBe("cancelled");expect(await messageDeliveryRepo.duplicateRisk(unknown.id,all)).toBe(true);
 await expect(messageDeliveryRepo.control(unknown.id,"retry",{reason:"不能跳过重复风险"},canceled.stateRevision,newId(),all,{actor:write.actor,authorize:async()=>{}})).rejects.toMatchObject({code:"MSG-7206"});
});
it("scopes idempotency to each channel and each logical delivery",async()=>{
 const first=await channel(),second=await channel(),key=newId();const a=await enqueue(first,key),b=await enqueue(second,key);expect(a.deliveryId).not.toBe(b.deliveryId);
 const controlKey=newId();for(const item of[a,b]){const row=(await messageDeliveryRepo.getDelivery(item.deliveryId,all))!;const result=await messageDeliveryRepo.control(row.id,"cancel",{reason:"分资源相同幂等键"},row.state_revision,controlKey,all,{actor:write.actor,authorize:async()=>{}});expect(result.status).toBe("cancelled");}
});
it("queues the twenty-first same-minute WeCom message without losing its delivery",async()=>{
 const row=await channel("wecom"),deliveries=[];for(let index=0;index<21;index++)deliveries.push(await enqueue(row));let sent=0;const transport:typeof safeFetch=async()=>{sent++;return new Response('{"errcode":0}')};await deliverMessages("throttle",transport);await deliverMessages("throttle",transport);expect(sent).toBe(20);
 const last=(await messageDeliveryRepo.getDelivery(deliveries[20]!.deliveryId,all))!;expect(last).toMatchObject({status:"retry_wait",cycle_attempts:0,total_attempts:1});expect(last.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
 const version=(await messageConfigRepo.getChannelVersion(row.published_version_id,row.id,all))!;await execute("DELETE FROM settings WHERE `key`=?",[`message-throttle:${version.endpoint_fingerprint}`]);await execute("UPDATE message_deliveries SET next_attempt_at=UTC_TIMESTAMP(3) WHERE id=?",[last.id]);await deliverMessages("throttle",transport);expect(sent).toBe(21);expect(await messageDeliveryRepo.getDelivery(last.id,all)).toMatchObject({status:"delivered",total_attempts:2,cycle_attempts:1});
});
it("requires duplicate acknowledgment after the final timed-out webhook attempt",async()=>{
 const row=await channel(),queued=await enqueue(row);await execute("UPDATE message_deliveries SET cycle_attempts=5 WHERE id=?",[queued.deliveryId]);await deliverMessages("exhausted",async()=>{throw Error("response lost")});const failed=(await messageDeliveryRepo.getDelivery(queued.deliveryId,all))!;expect(failed.status).toBe("failed");expect(await messageDeliveryRepo.duplicateRisk(failed.id,all)).toBe(true);
 await expect(messageDeliveryRepo.control(failed.id,"retry",{reason:"确认风险前不能再发"},failed.state_revision,newId(),all,{actor:write.actor,authorize:async()=>{}})).rejects.toMatchObject({code:"MSG-7206"});
});
it("rechecks source eligibility at the submitted dispatch boundary",async()=>{
 const row=await channel(),queued=await enqueue(row),claim=(await messageDeliveryRepo.prepare(queued.deliveryId,row.id,"eligibility-race",async()=>true))!;expect(claim).not.toBeNull();expect(await submit(claim,async()=>false)).toBe(false);expect(await messageDeliveryRepo.getDelivery(queued.deliveryId,all)).toMatchObject({status:"held",hold_reason:"credential_unavailable"});expect((await messageDeliveryRepo.listAttempts(queued.deliveryId,all)).items[0]).toMatchObject({status:"failed",submitted_at:null});
});
it("shares the twenty-per-minute quota across equivalent bot addresses while preserving raw fingerprints",async()=>{
 const key=`technical-${newId()}`,first=await channel("wecom",`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`),second=await channel("wecom",`https://qyapi.weixin.qq.com.:443/cgi-bin/webhook/send?unused=1&key=${key}`),bucket=`message-throttle:${sha256(`wecom-bot:${key}`)}`;
 try{
  const a=(await messageConfigRepo.getChannelVersion(first.published_version_id,first.id,all))!,b=(await messageConfigRepo.getChannelVersion(second.published_version_id,second.id,all))!;expect(a.endpoint_fingerprint).not.toBe(b.endpoint_fingerprint);
  for(let index=0;index<21;index++)await enqueue(index%2?first:second);let sent=0;const transport:typeof safeFetch=async()=>{sent++;return new Response('{"errcode":0}')};await deliverMessages("canonical-quota",transport);await deliverMessages("canonical-quota",transport);expect(sent).toBe(20);
  const held=await query<{count:number}>("SELECT COUNT(*) count FROM message_deliveries WHERE channel_id IN (?,?) AND status='retry_wait'",[first.id,second.id]);expect(Number(held[0]!.count)).toBe(1);
 }finally{await execute("DELETE FROM settings WHERE `key`=?",[bucket]);}
});
