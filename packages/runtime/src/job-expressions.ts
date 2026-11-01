import { ForgeError } from "@forge/core";
import { canonicalJobJson, JOB_CONDITION_SCHEMA, JOB_MAPPING_SCHEMA, type JobCondition, type JobJson, type JobMapping } from "@forge/contracts";

const missing = Symbol("missing");
type Value = JobJson | typeof missing;
export interface JobExpressionContext { input: JobJson; businessRef: JobJson; item: JobJson; steps: JobJson }
function reference(pointer: string, context: JobExpressionContext): Value {
  let value: JobExpressionContext | JobJson = context;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return missing;
    if (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/.test(key)) return missing;
    value = (value as Record<string, JobJson>)[key]!;
  }
  return value as JobJson;
}
function map(mapping: JobMapping, context: JobExpressionContext): Value {
  if ("literal" in mapping) return mapping.literal;
  if ("ref" in mapping) return reference(mapping.ref, context);
  if ("array" in mapping) {
    const values = mapping.array.map(entry => map(entry, context));
    return values.includes(missing) ? missing : values as JobJson[];
  }
  const entries: [string, JobJson][] = [];
  for (const [key, child] of Object.entries(mapping.object)) {
    const value = map(child, context);
    if (value === missing) return missing;
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}
function condition(expression: JobCondition, context: JobExpressionContext): boolean {
  if (typeof expression === "boolean") return expression;
  if (expression.op === "exists") return reference(expression.ref, context) !== missing;
  if (expression.op === "and" || expression.op === "or") {
    const values = expression.args.map(arg => condition(arg, context));
    return expression.op === "and" ? values.every(Boolean) : values.some(Boolean);
  }
  if (expression.op === "not") return !condition(expression.arg, context);
  if (!("left" in expression)) throw new ForgeError("QAL-7301");
  const left = map(expression.left, context), right = map(expression.right, context);
  if (left === missing || right === missing) return false;
  const equal = (a: JobJson, b: JobJson) => canonicalJobJson(a) === canonicalJobJson(b);
  switch (expression.op) {
    case "eq": return equal(left, right);
    case "ne": return !equal(left, right);
    case "in":
      if (!Array.isArray(right)) throw new ForgeError("QAL-7301");
      return right.some(value => equal(left, value));
    default:
      if (typeof left !== "number" || typeof right !== "number" || !Number.isFinite(left) || !Number.isFinite(right)) throw new ForgeError("QAL-7301");
      switch (expression.op) {
        case "gt": return left > right;
        case "gte": return left >= right;
        case "lt": return left < right;
        case "lte": return left <= right;
      }
  }
}
export function resolveJobMapping(input: unknown, context: JobExpressionContext): JobJson {
  const parsed = JOB_MAPPING_SCHEMA.safeParse(input);
  if (!parsed.success) throw new ForgeError("QAL-7301");
  const result = map(parsed.data, context);
  if (result === missing) throw new ForgeError("QAL-7301");
  return result;
}
export function evaluateJobCondition(input: unknown, context: JobExpressionContext): boolean {
  const parsed = JOB_CONDITION_SCHEMA.safeParse(input);
  if (!parsed.success) throw new ForgeError("QAL-7301");
  return condition(parsed.data, context);
}
