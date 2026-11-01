import {afterAll,expect,it} from "vitest";
import {newId,type QueryFilter} from "@forge/core";
import {messageConfigRepo,repos,execute,query,transaction,type MessageWrite} from "@forge/store";
const all:QueryFilter={allow:[{type:"all"}],deny:[],ceiling:{type:"all"}};
const options:MessageWrite={actor:{type:"user",id:"01J00000000000000000000001"},authorize:async()=>{}};
const ids:string[]=[];
afterAll(async()=>{for(const id of ids){const secrets=await query<{id:string}>("SELECT id FROM secrets WHERE scope_resource_type='message_channel' AND scope_id=?",[id]);await execute("DELETE FROM resource_references WHERE from_type='message_channel' AND from_id=?",[id]);await execute("UPDATE message_channels SET published_version_id=NULL WHERE id=?",[id]);await execute("DELETE FROM message_channel_versions WHERE channel_id=?",[id]);await execute("DELETE FROM message_channels WHERE id=?",[id]);for(const secret of secrets){await execute("DELETE FROM secret_versions WHERE secret_id=?",[secret.id]);await execute("DELETE FROM secrets WHERE id=?",[secret.id]);}await execute("DELETE FROM audit_logs WHERE resource_id=?",[id]);}});
it("saves encrypted disabled channels without any delivery and keeps immutable endpoint versions",async()=>{
 const row=await messageConfigRepo.createMessageChannel({key:`channel-${newId().toLowerCase()}`,name:"技术地址",type:"webhook",endpoint:{value:"https://example.invalid/callback?key=technical"},signingSecret:{value:"technical-signing"}},all,options);ids.push(row.id);
 expect(row.status).toBe("disabled");expect(await query("SELECT id FROM message_deliveries WHERE channel_id=?",[row.id])).toEqual([]);
 const first=await messageConfigRepo.getChannelVersion(row.published_version_id,row.id,all);expect(first).not.toBeNull();
 const saved=await messageConfigRepo.updateMessageChannel(row.id,{endpoint:{value:"https://example.invalid/changed?key=next"}},row.revision,all,options);
 expect(saved.published_version_id).not.toBe(row.published_version_id);
 const historical=await repos.resolveCredentialValues("message_channel",row.id,{[`endpoint-version:${first!.id}`]:first!.endpoint_secret_id});expect(historical[`endpoint-version:${first!.id}`]).toBe("https://example.invalid/callback?key=technical");
 await expect(repos.rotateSecret(first!.endpoint_secret_id,"https://example.invalid/wrong",{expectedRevision:1})).rejects.toMatchObject({code:"CFG-8503"});
});
it("metadata edits preserve target versions, CAS and SQL deny protect writes",async()=>{
 const row=await messageConfigRepo.createMessageChannel({key:`channel-${newId().toLowerCase()}`,name:"测试",type:"wecom",endpoint:{value:"https://example.invalid/robot"}},all,options);ids.push(row.id);
 const changed=await messageConfigRepo.updateMessageChannel(row.id,{name:"新名称"},1,all,options);expect(changed.published_version_id).toBe(row.published_version_id);expect(changed.revision).toBe(2);
 await expect(messageConfigRepo.updateMessageChannel(row.id,{name:"过期"},1,all,options)).rejects.toMatchObject({code:"MSG-7206"});
 expect(await messageConfigRepo.getMessageChannel(row.id,{...all,deny:[{type:"all"}]})).toBeNull();
});
it("rolls parent and credential inserts back when authorization fails",async()=>{
 const key=`channel-${newId().toLowerCase()}`;
 await expect(messageConfigRepo.createMessageChannel({key,name:"拒绝",type:"wecom",endpoint:{value:"https://example.invalid/robot"}},all,{...options,authorize:async()=>{throw Error("revoked")}})).rejects.toThrow("revoked");
 expect(await query("SELECT id FROM message_channels WHERE `key`=?",[key])).toEqual([]);
});
it("allows a snapshot clone only through the exact credential consumer scope",async()=>{
 const row=await messageConfigRepo.createMessageChannel({key:`channel-${newId().toLowerCase()}`,name:"归属",type:"wecom",endpoint:{value:"https://example.invalid/one"}},all,options);ids.push(row.id);
 const original=(await messageConfigRepo.getChannelVersion(row.published_version_id,row.id,all))!;
 const key=`channel-${newId().toLowerCase()}`;
 await expect(messageConfigRepo.createMessageChannel({key,name:"不能借用",type:"wecom",endpoint:{secretId:original.endpoint_secret_id}},all,options)).rejects.toMatchObject({code:"POL-2001"});
 expect(await query("SELECT id FROM message_channels WHERE `key`=?",[key])).toEqual([]);
 await transaction(async conn=>{const [rows]=await conn.query("SELECT id FROM message_channel_versions WHERE channel_id=?",[row.id]);expect(rows).toHaveLength(1);});
});
it("records safe before/after configuration metadata in the same transaction",async()=>{
 const row=await messageConfigRepo.createMessageChannel({key:`audit-channel-${newId().toLowerCase()}`,name:"审计技术样本",type:"wecom",endpoint:{value:"https://example.invalid/audit?key=must-not-appear"}},all,options);ids.push(row.id);await messageConfigRepo.updateMessageChannel(row.id,{name:"修改后的样本"},row.revision,all,options);
 const audit=(await query<{details_json:{before:{revision:number};after:{revision:number;versionId:string}}}>("SELECT details_json FROM audit_logs WHERE resource_id=? AND action='message_channel.update'",[row.id]))[0]!;expect(audit.details_json).toMatchObject({before:{revision:1},after:{revision:2,versionId:row.published_version_id}});expect(JSON.stringify(audit)).not.toContain("must-not-appear");
});
