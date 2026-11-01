import { ForgeError } from "@forge/core/errors";
import type { FastifyRequest } from "fastify";
import { CronExpressionParser } from "cron-parser";
import { CRON_INVALID_MESSAGE, errors } from "@forge/core";

export { AJV_CUSTOM_OPTIONS, ROUTE_SCHEMAS, SCHEDULE_STATUSES } from "@forge/contracts";

/** Messages that differ from the generic ones (kept from the previous checks). */
const FIELD_MESSAGES: Record<string, string> = {
  "email.pattern": "email 格式无效",
  "email.minLength": "缺少字段: email",
  "decision.enum": "decision 必须为 approved/rejected",
};

type AjvError = { keyword: string; instancePath: string; params: Record<string, unknown> };

function messageFor(error: AjvError, field: string, limitMax: string | undefined): string {
  // `limit` (I-RUN-02 / S-25): one message whatever failed (type, length or pattern), naming the route's maximum.
  if (field === "limit" && limitMax) return `limit 必须是 1-${limitMax} 之间的整数`;
  const custom = FIELD_MESSAGES[`${field}.${error.keyword}`];
  if (custom) return custom;
  if (error.keyword === "pattern" && /^scopes\.\d+$/.test(field)) return `${field} 不能包含通配符 *，请逐条列出 Scope`;
  switch (error.keyword) {
    case "required":
      return `缺少字段: ${field}`;
    case "type":
      if (!field) return "请求参数必须是 JSON 对象";
      return error.params.type === "string" ? `${field} 必须是字符串` : `${field} 类型无效`;
    case "maxLength":
      return `${field} 不能超过 ${String(error.params.limit)} 个字符`;
    case "minLength":
      return `${field} 不能为空`;
    case "maxItems":
      return `${field} 不能超过 ${String(error.params.limit)} 项`;
    case "enum":
      return `${field} 只能是 ${(error.params.allowedValues as unknown[]).join(" 或 ")}`;
    case "pattern":
      return `${field} 格式无效`;
    case "additionalProperties":
      return `不支持的字段: ${field}`;
    default:
      return `${field || "请求参数"} 无效`;
  }
}

/**
 * Runs the route's compiled schema for `part` on the request (a non-object body counts as {} like bodyOf) and throws
 * 400 CFG-8501 with details.field for the first error. Requires the route to be registered with that schema part.
 */
export function assertValidInput(request: FastifyRequest, part: "body" | "querystring" = "body"): void {
  const validate = request.getValidationFunction(part);
  if (!validate) throw new ForgeError("SYS-9001", { message: `route ${request.routeOptions.url ?? ""} has no ${part} schema` });
  const raw = part === "body" ? request.body : request.query;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (validate(value)) return;
  const error = (validate.errors?.[0] ?? { keyword: "invalid", instancePath: "", params: {} }) as AjvError;
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  const field =
    error.keyword === "required" ? String(error.params.missingProperty)
    : error.keyword === "additionalProperties" ? [path, String(error.params.additionalProperty)].filter(Boolean).join(".")
    : path;
  const schema = request.routeOptions.schema as { querystring?: { properties?: { limit?: { pattern?: string } } } } | undefined;
  const limitMax = /\|(\d+)\)\$$/.exec(schema?.querystring?.properties?.limit?.pattern ?? "")?.[1];
  throw errors.invalid(messageFor(error, field, limitMax), field ? { field } : undefined);
}

/** `limit` from an already validated querystring, or the default when absent. */
export function limitParam(request: FastifyRequest, fallback: number): number {
  const limit = (request.query as Record<string, unknown> | undefined)?.limit;
  return typeof limit === "string" ? Number(limit) : fallback;
}

export function isValidTimezone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function isValidCron(cron: string, timezone: string): boolean {
  // F2: standard 5-field cron only (minute hour day month weekday). The parser also takes 6-field (seconds) and pads
  // short expressions, which the scheduler and the console do not support; empty / 4-field / 6-field -> invalid.
  if (cron.trim().split(/\s+/).filter(Boolean).length !== 5) return false;
  try {
    CronExpressionParser.parse(cron, { currentDate: new Date(), tz: timezone }).next();
    return true;
  } catch {
    return false;
  }
}

/**
 * Effective cron + timezone after a create/patch: timezone first (I-SCH-04: an invalid timezone is reported as a
 * timezone error, not as a cron error), then cron against that timezone. Throws 400 CFG-8501. Callers pass the cron
 * through normalizeCron (@forge/core) first, so the accepted macros arrive here as 5-field expressions.
 */
export function assertScheduleTiming(cron: string, timezone: string): void {
  if (!isValidTimezone(timezone)) throw errors.invalid("时区无效", { field: "timezone" });
  if (!isValidCron(cron, timezone)) throw errors.invalid(CRON_INVALID_MESSAGE, { field: "cron" });
}
