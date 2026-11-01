import {boundedHttpSchema} from "./http-schema.js";
import { z } from "zod";
import { JOB_ID_SCHEMA, JOB_KEY_SCHEMA, JOB_NAME_SCHEMA, JOB_REASON_SCHEMA, MESSAGE_TEMPLATE_SCHEMA, MESSAGE_RETRY_SCHEMA, jobText } from "./job-messaging.js";

export const MESSAGE_STATUSES = ["queued", "sending", "retry_wait", "delivered", "failed", "unknown", "held", "cancelled"] as const;
export const MESSAGE_HOLD_REASONS = ["channel_disabled", "target_changed", "credential_unavailable", "migration_review"] as const;
export const MESSAGE_EVENT_TYPES = [
  "run.completed", "run.failed", "run.cancelled", "run.budget_exhausted", "run.waiting_approval",
  "job.queued", "job.started", "job.waiting", "job.paused", "job.resumed", "job.completed", "job.partial", "job.failed", "job.cancelled", "job.skipped",
  "human.required", "human.resolved", "quality.checked", "delivery.updated", "job.backlog", "delivery.overdue",
] as const;
export type MessageStatus = typeof MESSAGE_STATUSES[number];
export const MESSAGE_SECRET_INPUT_SCHEMA = z.union([
  z.object({ value: z.string().min(1).refine(value => new TextEncoder().encode(value).byteLength <= 65536, "凭据最多65536 UTF-8字节").refine(value => !/^env:/i.test(value) && !/^(?:\*+|\[REDACTED\])$/i.test(value), "请填写新凭据值") }).strict(),
  z.object({ secretId: JOB_ID_SCHEMA }).strict(),
]);
export const MESSAGE_ENDPOINT_INPUT_SCHEMA = MESSAGE_SECRET_INPUT_SCHEMA.refine(input => {
  if (!("value" in input)) return true;
  try {
    const url = new URL(input.value);
    return input.value.trim() === input.value && ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}, "目标地址必须为有效HTTP地址且不含用户信息或片段");
const unique = (values: string[]) => new Set(values).size === values.length;
const mentionedIds = z.array(z.string().regex(/^[a-zA-Z0-9_.@-]{1,64}$/).refine(value => value.toLowerCase() !== "@all" && value.toLowerCase() !== "all", "仅允许指定成员")).max(100).refine(unique, "成员重复");
const mentionedMobiles = z.array(z.string().regex(/^\+?[0-9]{5,20}$/)).max(100).refine(unique, "手机号重复");
export function validWecomPayload(body:string):boolean{
 try{const value:unknown=JSON.parse(body);return z.object({msgtype:z.literal("text"),text:z.object({content:z.string().min(1).refine(value=>new TextEncoder().encode(value).byteLength<=2048&&!/<@[^>]*>/.test(value)),mentioned_list:mentionedIds,mentioned_mobile_list:mentionedMobiles}).strict()}).strict().safeParse(value).success;}catch{return false;}
}
export const WECOM_RECIPIENTS_SCHEMA = z.object({ mentionedIds: mentionedIds.default([]), mentionedMobiles: mentionedMobiles.default([]) }).strict();
const headerSecretRefs = z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/), JOB_ID_SCHEMA).superRefine((headers, ctx) => {
  const names = Object.keys(headers).map(name => name.toLowerCase());
  if (names.length > 100 || new Set(names).size !== names.length || names.some(name => ["host", "content-type", "content-length", "connection", "transfer-encoding"].includes(name) || name.startsWith("x-forge-"))) ctx.addIssue({ code: "custom", message: "请求头重复、过多或保留" });
});
const channelFields = {
  name: JOB_NAME_SCHEMA, description: jobText(0, 1024).optional(), endpoint: MESSAGE_ENDPOINT_INPUT_SCHEMA,
  signingSecret: MESSAGE_SECRET_INPUT_SCHEMA.optional(), headerSecretRefs: headerSecretRefs.optional(),
  mentionedIds: mentionedIds.optional(), mentionedMobiles: mentionedMobiles.optional(),
};
export const MESSAGE_CHANNEL_CREATE_SCHEMA = z.object({ key: JOB_KEY_SCHEMA, type: z.enum(["webhook", "wecom"]), orgUnitId: JOB_ID_SCHEMA.nullable().optional(), ...channelFields }).strict().superRefine((channel, ctx) => {
  if (channel.type === "webhook" && !channel.signingSecret) ctx.addIssue({ code: "custom", path: ["signingSecret"], message: "Webhook需要签名凭据" });
  if(channel.type==="wecom"&&"value"in channel.endpoint&&!wecomTargetIdentity(channel.endpoint.value))ctx.addIssue({code:"custom",path:["endpoint"],message:"机器人地址需要唯一的 key 参数"});
  if (channel.type === "wecom" && channel.signingSecret !== undefined) ctx.addIssue({ code: "custom", path: ["signingSecret"], message: "企业微信渠道不使用签名凭据" });
});
export const MESSAGE_CHANNEL_PATCH_SCHEMA = z.object({ ...channelFields, status: z.enum(["active", "disabled"]) }).partial().strict();
export const MESSAGE_SCOPE_SCHEMA = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }).strict(),
  z.object({ type: z.enum(["job", "agent", "api_app", "org"]), id: JOB_ID_SCHEMA }).strict(),
]);
const ruleFields = {
  name: JOB_NAME_SCHEMA, eventType: z.enum(MESSAGE_EVENT_TYPES), scope: MESSAGE_SCOPE_SCHEMA,
  channelId: JOB_ID_SCHEMA, templateVersionId: JOB_ID_SCHEMA.nullable().optional(),
  includeNestedRuns: z.boolean(), status: z.enum(["active", "disabled"]),
};
export const MESSAGE_RULE_CREATE_SCHEMA = z.object({ key: JOB_KEY_SCHEMA, ...ruleFields, includeNestedRuns: ruleFields.includeNestedRuns.default(false) }).strict();
export const MESSAGE_RULE_PATCH_SCHEMA = z.object(ruleFields).partial().strict();
export const MESSAGE_TEMPLATE_PATCH_SCHEMA = z.object(MESSAGE_TEMPLATE_SCHEMA.shape).partial().omit({ key: true }).strict();
export const MESSAGE_TEST_SCHEMA = z.object({ templateVersionId: JOB_ID_SCHEMA.optional(), eventType: z.enum(["test.webhook", "test.wecom"]) }).strict();
export const MESSAGE_CANCEL_SCHEMA = z.object({ reason: JOB_REASON_SCHEMA }).strict();
export const JOB_IDEMPOTENCY_KEY_SCHEMA = z.string().trim().min(1).max(200).regex(/^[\x21-\x7e]+$/);
export type MessageChannelCreate = z.output<typeof MESSAGE_CHANNEL_CREATE_SCHEMA>;
export type MessageChannelPatch = z.output<typeof MESSAGE_CHANNEL_PATCH_SCHEMA>;
export type MessageRuleCreate = z.output<typeof MESSAGE_RULE_CREATE_SCHEMA>;

export interface MessageChannelDetail {
 id:string;key:string;name:string;description:string;type:"webhook"|"wecom";orgUnitId:string|null;status:string;revision:number;activeVersionId:string;
 endpointMasked:string;endpointFingerprint:string;credentialConfigured:boolean;legacyAppId:string|null;mentionedIds?:string[];mentionedMobiles?:string[];referenceCount:number;allowedActions:("manage"|"test")[];createdAt:string;updatedAt:string;
}
export const MESSAGE_PAGE_QUERY_SCHEMA=z.object({limit:z.string().regex(/^(?:[1-9][0-9]?|1[0-9]{2}|200)$/).optional(),cursor:z.string().max(2048).optional(),status:z.enum(["active","disabled"]).optional()}).strict();
export const MESSAGE_VERSION_PAGE_SCHEMA=MESSAGE_PAGE_QUERY_SCHEMA.pick({limit:true,cursor:true}).strict();
export const MESSAGE_HTTP_SCHEMAS={
 versionPage:{querystring:boundedHttpSchema(z.toJSONSchema(MESSAGE_VERSION_PAGE_SCHEMA,{target:"draft-7"}))},
 channelCreate:{body:boundedHttpSchema(z.toJSONSchema(MESSAGE_CHANNEL_CREATE_SCHEMA,{unrepresentable:"any",io:"input",target:"draft-7"}))},
 channelPatch:{body:boundedHttpSchema(z.toJSONSchema(MESSAGE_CHANNEL_PATCH_SCHEMA,{unrepresentable:"any",io:"input",target:"draft-7"}))},
 page:{querystring:boundedHttpSchema(z.toJSONSchema(MESSAGE_PAGE_QUERY_SCHEMA,{target:"draft-7"}))},
};

export const MESSAGE_DELIVERY_QUERY_SCHEMA=z.object({limit:MESSAGE_PAGE_QUERY_SCHEMA.shape.limit,cursor:MESSAGE_PAGE_QUERY_SCHEMA.shape.cursor,status:z.enum(MESSAGE_STATUSES).optional(),channelId:JOB_ID_SCHEMA.optional(),eventType:z.enum([...MESSAGE_EVENT_TYPES,"test.webhook","test.wecom"]).optional(),sourceType:z.enum(["job","run","test"]).optional(),sourceId:JOB_ID_SCHEMA.optional(),createdFrom:z.iso.datetime({offset:true}).optional(),createdBefore:z.iso.datetime({offset:true}).optional(),from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional()}).strict().superRefine((value,ctx)=>{
 for(const [canonical,alias] of [["createdFrom","from"],["createdBefore","to"]] as const)if(value[canonical]&&value[alias]&&Date.parse(value[canonical])!==Date.parse(value[alias]))ctx.addIssue({code:"custom",path:[canonical],message:"时间筛选参数冲突"});
 const from=value.createdFrom??value.from,to=value.createdBefore??value.to;
 if(from&&to&&Date.parse(from)>Date.parse(to))ctx.addIssue({code:"custom",path:[value.createdBefore?"createdBefore":"to"],message:"结束时间早于开始时间"});
});
export const MESSAGE_ACTION_HTTP_SCHEMAS={
 test:{body:boundedHttpSchema(z.toJSONSchema(MESSAGE_TEST_SCHEMA,{target:"draft-7"}))},retry:{body:boundedHttpSchema(z.toJSONSchema(MESSAGE_RETRY_SCHEMA,{target:"draft-7"}))},cancel:{body:boundedHttpSchema(z.toJSONSchema(MESSAGE_CANCEL_SCHEMA,{target:"draft-7"}))},deliveries:{querystring:boundedHttpSchema(z.toJSONSchema(MESSAGE_DELIVERY_QUERY_SCHEMA,{target:"draft-7"}))}
};
export interface MessageSummary {id:string;eventId:string;eventType:string;sourceType:string;sourceId:string;channelId:string;channelVersionId:string;status:MessageStatus;holdReason:string|null;stateRevision:number;sendCycle:number;totalAttempts:number;nextAttemptAt:string|null;firstDeliveredAt:string|null;lastDeliveredAt:string|null;lastErrorCode:string|null;createdAt:string}
export interface MessageDetail extends MessageSummary {matchedRules:unknown;templateVersionId:string|null;payloadHash:string;attemptsUrl:string;payload:unknown;bodyRedacted:boolean;duplicateRisk:boolean;allowedActions:("retry"|"cancel")[]}
export interface MessageAttempt {id:string;attemptNo:number;sendCycle:number;status:string;channelVersionId:string;endpointFingerprint:string;payloadHash:string;submittedAt:string|null;completedAt:string|null;responseStatus:number|null;responseSummary:string|null;errorCode:string|null;uncertain:boolean;createdAt:string}
export const MESSAGE_TEMPLATE_CREATE_SCHEMA=MESSAGE_TEMPLATE_SCHEMA.safeExtend({orgUnitId:JOB_ID_SCHEMA.nullable().optional()});
export const MESSAGE_CATALOG_HTTP_SCHEMAS={templateCreate:{body:boundedHttpSchema(z.toJSONSchema(MESSAGE_TEMPLATE_CREATE_SCHEMA,{target:"draft-7",unrepresentable:"any",io:"input"}))},templatePatch:{body:boundedHttpSchema(z.toJSONSchema(MESSAGE_TEMPLATE_PATCH_SCHEMA,{target:"draft-7",unrepresentable:"any",io:"input"}))},ruleCreate:{body:boundedHttpSchema(z.toJSONSchema(MESSAGE_RULE_CREATE_SCHEMA,{target:"draft-7",unrepresentable:"any",io:"input"}))},rulePatch:{body:boundedHttpSchema(z.toJSONSchema(MESSAGE_RULE_PATCH_SCHEMA,{target:"draft-7",unrepresentable:"any",io:"input"}))}};
export type MessageTemplateCreate=z.output<typeof MESSAGE_TEMPLATE_CREATE_SCHEMA>;
export type MessageTemplatePatch=z.output<typeof MESSAGE_TEMPLATE_PATCH_SCHEMA>;
export type MessageRulePatch=z.output<typeof MESSAGE_RULE_PATCH_SCHEMA>;
export interface MessageTemplateDetail {id:string;key:string;name:string;description:string;orgUnitId:string|null;status:string;revision:number;activeVersionId:string|null;draft?:{content:string;variables:MessageTemplateCreate["variables"]};allowedActions:"manage"[];createdAt:string;updatedAt:string}
export interface MessageTemplateVersion {id:string;templateId:string;version:number;content:string;variables:MessageTemplateCreate["variables"];contentHash:string;createdAt:string}
export interface MessageRuleDetail {id:string;key:string;name:string;eventType:MessageRuleCreate["eventType"];scope:MessageRuleCreate["scope"];channelId:string;templateVersionId:string|null;templateId:string|null;includeNestedRuns:boolean;status:string;revision:number;orgUnitId:string|null;allowedActions:"manage"[];createdAt:string;updatedAt:string}
// Keys normalize whitespace in the semantic schema; raw HTTP validation must not reject before normalization.
for(const body of [MESSAGE_HTTP_SCHEMAS.channelCreate.body,MESSAGE_CATALOG_HTTP_SCHEMAS.templateCreate.body,MESSAGE_CATALOG_HTTP_SCHEMAS.ruleCreate.body])Object.assign(body.properties!,{key:{type:"string",maxLength:65536}});

/** One official bot key has one quota, even when URL syntax or irrelevant query parameters differ. */
export function wecomTargetIdentity(endpoint:string):string|null{
 try{
  const url=new URL(endpoint);
  if(url.hostname.replace(/\.+$/,"")==="qyapi.weixin.qq.com"){
   const keys=url.searchParams.getAll("key");if(keys.length!==1||!keys[0])return null;
   return `wecom-bot:${keys[0]}`;
  }
  url.searchParams.sort();return url.href;
 }catch{return null;}
}

export type MessageChannelCreateInput = z.input<typeof MESSAGE_CHANNEL_CREATE_SCHEMA>;
export type MessageChannelPatchInput = z.input<typeof MESSAGE_CHANNEL_PATCH_SCHEMA>;
export type MessageTemplateCreateInput = z.input<typeof MESSAGE_TEMPLATE_CREATE_SCHEMA>;
export type MessageTemplatePatchInput = z.input<typeof MESSAGE_TEMPLATE_PATCH_SCHEMA>;
export type MessageRuleCreateInput = z.input<typeof MESSAGE_RULE_CREATE_SCHEMA>;
export type MessageRulePatchInput = z.input<typeof MESSAGE_RULE_PATCH_SCHEMA>;
