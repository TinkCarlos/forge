import {expect,it} from "vitest";
import {createMessageClient} from "../packages/sdk/src/message-client.js";
import {MESSAGE_DELIVERY_QUERY_SCHEMA} from "@forge/contracts";
it("serializes only contract query parameters and preserves resource ETag/idempotency headers",async()=>{
 const calls:{path:string;options?:{headers?:Record<string,string>}}[]=[],client=createMessageClient(async<T>(path:string,options?:{headers?:Record<string,string>})=>{calls.push({path,options});return{} as T});
 await client.deliveries.list({status:"held",...{tab:"deliveries"}});expect(calls[0]!.path).toBe("/admin/api/message-deliveries?status=held");await client.deliveries.retry("id/encoded",7,"stable-key",{reason:"验证"});expect(calls[1]).toMatchObject({path:"/admin/api/message-deliveries/id%2Fencoded/retry",options:{headers:{"If-Match":'"7"',"Idempotency-Key":"stable-key"}}});
});
it("compares timestamps by milliseconds despite optional fractional precision",()=>{
 expect(MESSAGE_DELIVERY_QUERY_SCHEMA.safeParse({from:"2026-11-01T00:00:00Z",to:"2026-11-01T00:00:00.001Z"}).success).toBe(true);
 expect(MESSAGE_DELIVERY_QUERY_SCHEMA.safeParse({from:"2026-11-01T00:00:00.001Z",to:"2026-11-01T00:00:00Z"}).success).toBe(false);
});
it("canonicalizes equivalent WeCom bot target syntax without changing frozen addresses",async()=>{
 const {wecomTargetIdentity}=await import("@forge/contracts");
 expect(wecomTargetIdentity("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=technical-bot")).toBe(wecomTargetIdentity("https://QYAPI.WEIXIN.QQ.COM:443/cgi-bin/webhook/send?unused=1&key=technical%2Dbot"));
 expect(wecomTargetIdentity("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=a&key=b")).toBeNull();
 expect(wecomTargetIdentity("https://qyapi.weixin.qq.com./cgi-bin/webhook/send?key=technical-bot")).toBe(wecomTargetIdentity("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=technical-bot"));
 expect(wecomTargetIdentity("https://qyapi.weixin.qq.com./cgi-bin/webhook/send")).toBeNull();
});

it("accepts canonical timezone-aware half-open time filters and rejects conflicting aliases",()=>{
 expect(MESSAGE_DELIVERY_QUERY_SCHEMA.safeParse({createdFrom:"2026-11-01T08:00:00+08:00",createdBefore:"2026-11-01T00:00:00.001Z"}).success).toBe(true);
 expect(MESSAGE_DELIVERY_QUERY_SCHEMA.safeParse({createdFrom:"2026-11-01T08:00:00+08:00",from:"2026-11-01T00:00:00Z"}).success).toBe(true);
 expect(MESSAGE_DELIVERY_QUERY_SCHEMA.safeParse({createdFrom:"2026-11-01T00:00:00Z",from:"2026-11-01T00:00:00.001Z"}).success).toBe(false);
 expect(MESSAGE_DELIVERY_QUERY_SCHEMA.safeParse({createdFrom:"2026-11-01T00:00:00"}).success).toBe(false);
});
it("preserves canonical creation bounds in the typed client",async()=>{
 let path="";const client=createMessageClient(async<T>(p:string)=>{path=p;return{} as T});
 await client.deliveries.list({createdFrom:"2026-11-01T00:00:00Z",createdBefore:"2026-11-02T00:00:00Z"});
 expect(Object.fromEntries(new URL(path,"http://local.test").searchParams)).toEqual({createdFrom:"2026-11-01T00:00:00Z",createdBefore:"2026-11-02T00:00:00Z"});
});

it('accepts minimal message configuration inputs with server defaults omitted',async()=>{
 const {MESSAGE_CHANNEL_CREATE_SCHEMA,MESSAGE_TEMPLATE_CREATE_SCHEMA,MESSAGE_RULE_CREATE_SCHEMA}=await import('@forge/contracts');
 const client=createMessageClient(async<T>()=>({}) as T),channel={key:'minimal-channel',name:'技术渠道',type:'wecom' as const,endpoint:{value:'https://example.invalid/bot'}};
 const template={key:'minimal-template',name:'技术模板',content:'{{taskName}}',variables:['taskName' as const]};
 const rule={key:'minimal-rule',name:'技术规则',status:'disabled' as const,eventType:'run.completed' as const,scope:{type:'global' as const},channelId:'01J00000000000000000000000'};
 expect(MESSAGE_CHANNEL_CREATE_SCHEMA.safeParse(channel).success).toBe(true);expect(MESSAGE_TEMPLATE_CREATE_SCHEMA.safeParse(template).success).toBe(true);expect(MESSAGE_RULE_CREATE_SCHEMA.safeParse(rule).success).toBe(true);
 await client.channels.create(channel);await client.templates.create(template);await client.rules.create(rule);
});
