import { z } from "zod";
import { jobGraphIssues } from "./job-graph.js";
import { JOB_ID_SCHEMA, JOB_JSON_OBJECT_SCHEMA, JOB_JSON_VALUE_SCHEMA, JOB_KEY_SCHEMA, JOB_LIMITS_SCHEMA, JOB_NAME_SCHEMA, jobText } from "./job-messaging.js";

export const JOB_STATUSES = ["queued", "running", "waiting", "pausing", "paused", "cancelling", "succeeded", "partial", "failed", "cancelled", "skipped"] as const;
export const JOB_WAIT_REASONS = ["approval", "human", "external", "reconcile", "resource", "budget", "previous_execution"] as const;
export const JOB_STEP_KINDS = ["agent", "domain", "script", "browser", "external", "human", "gate", "condition", "map", "join"] as const;
export const JOB_STEP_STATUSES = ["blocked", "ready", "dispatched", "running", "waiting", "succeeded", "failed", "cancelled", "skipped"] as const;
export const JOB_ATTEMPT_STATUSES = ["prepared", "submitted", "running", "succeeded", "failed", "unknown", "cancelled"] as const;
export const JOB_SIDE_EFFECT_STATES = ["not_submitted", "submitted", "confirmed", "unknown"] as const;
export type JobStatus = typeof JOB_STATUSES[number];
export type JobStepStatus = typeof JOB_STEP_STATUSES[number];
export type JobSideEffectState = typeof JOB_SIDE_EFFECT_STATES[number];

import { canonicalJobJson, type JobJson } from "./job-json.js";
export type { JobJson } from "./job-json.js";
export type JobMapping = { literal: JobJson } | { ref: string } | { object: Record<string, JobMapping> } | { array: JobMapping[] };
export type JobCondition = boolean | { op: "exists"; ref: string } | { op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in"; left: JobMapping; right: JobMapping } | { op: "and" | "or"; args: JobCondition[] } | { op: "not"; arg: JobCondition };
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export const JOB_POINTER_SCHEMA = z.string().regex(/^\/(input|businessRef|item|steps)(?:\/(?:[^~/*]|~[01])*)*$/).refine(value => value.split("/").slice(1).every(part => !forbidden.has(part.replace(/~1/g, "/").replace(/~0/g, "~"))), "引用路径不允许访问原型");

// Bounded schema construction rejects deep input before recursive parsing can exhaust the stack.
function mappingAt(depth: number): z.ZodType<JobMapping> {
  const leaves = [z.object({ literal: JOB_JSON_VALUE_SCHEMA }).strict(), z.object({ ref: JOB_POINTER_SCHEMA }).strict()] as const;
  return depth === 8 ? z.union(leaves) : z.union([...leaves,
    z.object({ object: z.record(z.string().refine(key => !forbidden.has(key)), mappingAt(depth + 1)) }).strict(),
    z.object({ array: z.array(mappingAt(depth + 1)) }).strict(),
  ]);
}
export const JOB_MAPPING_SCHEMA = mappingAt(1);
function conditionAt(depth: number): z.ZodType<JobCondition> {
  const leaves = [z.boolean(), z.object({ op: z.literal("exists"), ref: JOB_POINTER_SCHEMA }).strict(),
    z.object({ op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "in"]), left: JOB_MAPPING_SCHEMA, right: JOB_MAPPING_SCHEMA }).strict()] as const;
  return depth === 8 ? z.union(leaves) : z.union([...leaves,
    z.object({ op: z.enum(["and", "or"]), args: z.array(conditionAt(depth + 1)).min(1).max(20) }).strict(),
    z.object({ op: z.literal("not"), arg: conditionAt(depth + 1) }).strict(),
  ]);
}
export const JOB_CONDITION_SCHEMA = conditionAt(1).refine(value => new TextEncoder().encode(canonicalJobJson(value)).byteLength <= 16384, "条件最多16 KiB");
export const JOB_TARGET_SCHEMA = z.object({
  kind: z.enum(["agent", "flow", "skill", "external", "evaluation"]), key: JOB_KEY_SCHEMA,
  version: jobText(1, 128), checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const jsonSchema = JOB_JSON_OBJECT_SCHEMA.superRefine((value, ctx) => {
  const visit = (node: JobJson, depth: number): void => {
    if (depth > 64) { ctx.addIssue({ code: "custom", message: "Schema层级过深" }); return; }
    if (Array.isArray(node)) { for (const child of node) visit(child, depth + 1); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if ((key === "$ref" || key === "$dynamicRef") && (typeof child !== "string" || !child.startsWith("#"))) ctx.addIssue({ code: "custom", message: "不允许远程Schema引用" });
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
});
export const JOB_NODE_SCHEMA = z.object({
  key: JOB_KEY_SCHEMA, kind: z.enum(JOB_STEP_KINDS), dependsOn: z.array(JOB_KEY_SCHEMA).max(128),
  target: JOB_TARGET_SCHEMA.optional(), condition: JOB_CONDITION_SCHEMA.nullable().default(null),
  inputMapping: JOB_MAPPING_SCHEMA, outputSchema: jsonSchema,
  maxIterations: z.number().int().min(1).max(100).optional(),
  timeoutSeconds: z.number().int().min(1).max(86400).default(300),
  maxAttempts: z.number().int().min(1).max(5).default(2),
}).strict().superRefine((node, ctx) => {
  if (["agent", "domain", "script", "browser", "external"].includes(node.kind) && !node.target) ctx.addIssue({ code: "custom", path: ["target"], message: "请选择登记目标" });
  if (new Set(node.dependsOn).size !== node.dependsOn.length) ctx.addIssue({ code: "custom", path: ["dependsOn"], message: "依赖重复" });
});
export const JOB_MANIFEST_SCHEMA = z.object({
  schemaVersion: z.literal(1), target: JOB_TARGET_SCHEMA, inputSchema: jsonSchema, outputSchema: jsonSchema,
  nodes: z.array(JOB_NODE_SCHEMA).max(128), outcomeNodeKey: JOB_KEY_SCHEMA.optional(),
  limits: JOB_LIMITS_SCHEMA.default(() => JOB_LIMITS_SCHEMA.parse({})),
  resourcePolicy: JOB_TARGET_SCHEMA.optional(), eligibilityAdapter: JOB_TARGET_SCHEMA.optional(),
}).strict().superRefine((manifest, ctx) => {
  const keys = new Set(manifest.nodes.map(node => node.key));
  if (keys.size !== manifest.nodes.length) ctx.addIssue({ code: "custom", path: ["nodes"], message: "节点Key重复" });
  if (manifest.target.kind === "flow") {
    if (!manifest.nodes.length || !manifest.outcomeNodeKey || !keys.has(manifest.outcomeNodeKey)) ctx.addIssue({ code: "custom", path: ["outcomeNodeKey"], message: "流程须指定有效的输出节点" });
  } else if (manifest.nodes.length || manifest.outcomeNodeKey !== undefined) ctx.addIssue({ code: "custom", path: ["nodes"], message: "单目标任务不声明流程节点" });
  for (const issue of jobGraphIssues(manifest.nodes, manifest.outcomeNodeKey)) ctx.addIssue({ code: "custom", ...issue });
  manifest.nodes.forEach((node, index) => {
    if (node.dependsOn.some(key => !keys.has(key))) ctx.addIssue({ code: "custom", path: ["nodes", index, "dependsOn"], message: "依赖节点不存在" });
  });
}).transform(manifest => ({ ...manifest, nodes: manifest.nodes.map(node => ({ ...node, maxIterations: node.maxIterations ?? 1 })) }));
const jobFields = {
  name: JOB_NAME_SCHEMA, description: jobText(0, 1024), businessType: jobText(1, 64),
  orgUnitId: JOB_ID_SCHEMA.nullable().optional(), responsibleUserId: JOB_ID_SCHEMA.nullable().optional(),
  draft: JOB_MANIFEST_SCHEMA, status: z.enum(["active", "disabled"]),
};
export const JOB_CREATE_SCHEMA = z.object({ key: JOB_KEY_SCHEMA, ...jobFields, description: jobFields.description.default(""), status: jobFields.status.default("disabled") }).strict();
export const JOB_PATCH_SCHEMA = z.object(jobFields).partial().strict();
export const JOB_APP_GRANT_SCHEMA = z.object({ appId: JOB_ID_SCHEMA, actions: z.array(z.enum(["run", "read", "cancel"])).min(1).max(3), status: z.enum(["active", "disabled"]) }).strict().refine(value => new Set(value.actions).size === value.actions.length, "授权动作重复");
export type JobManifest = z.output<typeof JOB_MANIFEST_SCHEMA>;
export type JobCreate = z.output<typeof JOB_CREATE_SCHEMA>;
export type JobPatch = z.output<typeof JOB_PATCH_SCHEMA>;

export type JobCreateInput = z.input<typeof JOB_CREATE_SCHEMA>;
export type JobPatchInput = z.input<typeof JOB_PATCH_SCHEMA>;
