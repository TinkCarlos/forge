import { z } from "zod";
import { isJobJson, canonicalJobJson, type JobJson } from "./job-json.js";
import { ID_PATTERN_SOURCE } from "../../core/src/ids.js";

export const JOB_INPUT_MAX_BYTES = 1_048_576;
export const JOB_ITEM_MAX_BYTES = 65_536;
export const MESSAGE_TEXT_MAX_BYTES = 2048;
const encoder = new TextEncoder();
const codePoints = (value: string) => Array.from(value).length;
export const jobText = (minimum: number, maximum: number) => z.string().refine(value => codePoints(value) >= minimum && codePoints(value) <= maximum, `长度须为${minimum}–${maximum}个Unicode码点`);
export const JOB_ID_SCHEMA = z.string().regex(new RegExp(ID_PATTERN_SOURCE));
export const JOB_KEY_SCHEMA = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
export const JOB_REASON_SCHEMA = jobText(1, 1024).refine(value => value.trim().length > 0, "请填写操作原因");
export const JOB_JSON_VALUE_SCHEMA = z.custom<JobJson>(isJobJson, "必须为有效JSON值");
export const JOB_JSON_OBJECT_SCHEMA = z.record(z.string(), JOB_JSON_VALUE_SCHEMA);
const jsonBytes = (value: unknown) => encoder.encode(canonicalJobJson(value as JobJson)).byteLength;

export const JOB_NAME_SCHEMA = z.string().trim().pipe(jobText(1, 128));
export const JOB_COST_LIMIT_SCHEMA = z.string().regex(/^(?:0|[1-9][0-9]{0,4})\.[0-9]{6}$/).refine(value => {
  if (!/^(?:0|[1-9][0-9]{0,4})\.[0-9]{6}$/.test(value)) return false;
  const micros = BigInt(value.replace(".", ""));
  return micros >= 1n && micros <= 10_000_000_000n;
}, "预算须为0.000001–10000.000000美元，保留6位小数");

export const JOB_LIMITS_SCHEMA = z.object({
  maxConcurrentExecutions: z.number().int().min(1).max(20).default(1),
  maxParallelItems: z.number().int().min(1).max(16).default(2),
  stepTimeoutSeconds: z.number().int().min(1).max(86400).default(300),
  activeTimeoutSeconds: z.number().int().min(1).max(604800).default(3600),
  waitTimeoutSeconds: z.number().int().min(60).max(7776000).default(604800),
  maxAttempts: z.number().int().min(1).max(5).default(2),
  maxCostUsd: JOB_COST_LIMIT_SCHEMA.default("1.000000"),
}).strict();

const item = z.object({ key: jobText(1, 128).refine(value => value.trim().length > 0), input: JOB_JSON_OBJECT_SCHEMA }).strict().superRefine((value, context) => {
  if (jsonBytes(value) > JOB_ITEM_MAX_BYTES) context.addIssue({ code: "custom", message: "单明细最多64 KiB" });
});
const items = z.array(item).min(1).max(1000).superRefine((value, context) => {
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (seen.has(entry.key)) context.addIssue({ code: "custom", path: [index, "key"], message: "明细Key重复" });
    seen.add(entry.key);
  });
});
const invokeProperties = {
  input: JOB_JSON_OBJECT_SCHEMA,
  businessRef: z.object({ type: jobText(1, 64), id: jobText(1, 128), period: jobText(1, 64).optional() }).strict(),
  items: items.optional(),
};
const inputSize = (value: unknown, context: z.RefinementCtx) => {
  if (jsonBytes(value) > JOB_INPUT_MAX_BYTES) context.addIssue({ code: "custom", message: "业务输入最多1 MiB" });
};
// Raw request bytes (including whitespace) must also be limited by the receiving HTTP route.
export const JOB_INVOKE_SCHEMA = z.object({ ...invokeProperties, versionId: JOB_ID_SCHEMA.optional() }).strict().superRefine(inputSize);
export const JOB_EXTERNAL_INVOKE_SCHEMA = z.object(invokeProperties).strict().superRefine(inputSize);
export const JOB_CONTROL_SCHEMA = z.object({
  action: z.enum(["pause", "resume", "cancel", "retry_failed", "rerun"]),
  reason: JOB_REASON_SCHEMA,
  stepIds: z.array(JOB_ID_SCHEMA).min(1).max(100).optional(),
  acknowledgeSideEffects: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.stepIds !== undefined && value.action !== "retry_failed") context.addIssue({ code: "custom", path: ["stepIds"], message: "仅失败恢复可指定步骤" });
  if (value.stepIds && new Set(value.stepIds).size !== value.stepIds.length) context.addIssue({ code: "custom", path: ["stepIds"], message: "步骤ID重复" });
  if (value.acknowledgeSideEffects !== undefined && value.action !== "rerun") context.addIssue({ code: "custom", path: ["acknowledgeSideEffects"], message: "仅整体重跑可确认副作用" });
});

export const MESSAGE_RETRY_SCHEMA = z.object({
  reason: JOB_REASON_SCHEMA,
  acknowledgeDuplicate: z.boolean().optional(),
  acknowledgeHistoricalTarget: z.boolean().optional(),
}).strict();

export const MESSAGE_TEMPLATE_VARIABLES = ["taskName", "businessSummary", "status", "executionId", "runId", "approvalId", "responsibleName", "url"] as const;
export const MESSAGE_TEMPLATE_SCHEMA = z.object({
  key: JOB_KEY_SCHEMA,
  name: JOB_NAME_SCHEMA,
  description: jobText(0, 1024).optional(),
  content: z.string().min(1).refine(value => encoder.encode(value).byteLength <= MESSAGE_TEXT_MAX_BYTES, "文本最多2048 UTF-8字节"),
  variables: z.array(z.enum(MESSAGE_TEMPLATE_VARIABLES)).max(MESSAGE_TEMPLATE_VARIABLES.length),
  status: z.enum(["active", "disabled"]).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.variables).size !== value.variables.length) context.addIssue({ code: "custom", path: ["variables"], message: "模板变量重复" });
  if (/<@[^>]*>/.test(value.content)) context.addIssue({ code: "custom", path: ["content"], message: "请通过成员列表指定提醒对象" });
  const declared = new Set<string>(value.variables);
  const remainder = value.content.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_match, variable: string) => {
    if (!declared.has(variable)) context.addIssue({ code: "custom", path: ["content"], message: "模板引用了未声明变量" });
    return "";
  });
  if (remainder.includes("{{") || remainder.includes("}}")) context.addIssue({ code: "custom", path: ["content"], message: "模板变量格式无效" });
});

export type JobLimits = z.output<typeof JOB_LIMITS_SCHEMA>;
export type JobInvoke = z.output<typeof JOB_INVOKE_SCHEMA>;
export type JobControl = z.output<typeof JOB_CONTROL_SCHEMA>;
export type MessageRetry = z.output<typeof MESSAGE_RETRY_SCHEMA>;
export type MessageTemplate = z.output<typeof MESSAGE_TEMPLATE_SCHEMA>;
