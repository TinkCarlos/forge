import { z, type ZodTypeAny } from "zod";
import { CronExpressionParser } from "cron-parser";
import { errors } from "@forge/core";

/**
 * Route input schemas (K-23 / K-24 / I-USR-02 / I-APR-34 / I-RUN-02 / S-25).
 *
 * Inputs are checked here, in the route layer, before anything touches the database, and a bad input is always
 * 400 CFG-8501 (`errors.invalid`) with `details.field`. The errorHandler does not map anything and DB errors are
 * never translated to 400: a value that would overflow a column is rejected by these limits first.
 * Lengths mirror packages/store/src/schema.sql.
 */
export function parseInput<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  const field = issue.path.join(".");
  throw errors.invalid(issue.message, field ? { field } : undefined);
}

export function boundedString(field: string, max: number) {
  return z
    .string({ invalid_type_error: `${field} 必须是字符串` })
    .max(max, `${field} 不能超过 ${max} 个字符`);
}

/** Query or body integer: a number or a decimal-digit string, no sign/decimal/exponent; within [min, max]. */
export function integerParam(field: string, min: number, max: number) {
  return z
    .union([z.number(), z.string()], { invalid_type_error: `${field} 必须是整数` })
    .transform((value, ctx) => {
      const n = typeof value === "number" ? value : /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} 必须是 ${min}-${max} 之间的整数` });
        return z.NEVER;
      }
      return n;
    });
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
  try {
    CronExpressionParser.parse(cron, { currentDate: new Date(), tz: timezone }).next();
    return true;
  } catch {
    return false;
  }
}

// agents: name VARCHAR(128), description VARCHAR(1024)
export const agentFieldsSchema = z
  .object({ name: boundedString("name", 128).optional(), description: boundedString("description", 1024).optional() })
  .passthrough();

// users: email VARCHAR(255), username VARCHAR(64), display_name VARCHAR(128)
export const userCreateSchema = z
  .object({
    email: z
      .string({ required_error: "缺少字段: email", invalid_type_error: "email 必须是字符串" })
      .trim()
      .min(1, "缺少字段: email")
      .max(255, "email 不能超过 255 个字符")
      .email("email 格式无效"),
    username: boundedString("username", 64).optional(),
    displayName: boundedString("displayName", 128).optional(),
  })
  .passthrough();

// approvals: comment VARCHAR(1024)
export const approvalDecideSchema = z
  .object({
    decision: z.enum(["approved", "rejected"], { errorMap: () => ({ message: "decision 必须为 approved/rejected" }) }),
    comment: boundedString("comment", 1024).optional(),
  })
  .passthrough();

/** List `limit` query: optional; when present a positive integer up to `max`. */
export function limitQuerySchema(max: number) {
  return z.object({ limit: integerParam("limit", 1, max).optional() }).passthrough();
}

// schedules: name VARCHAR(128), cron VARCHAR(128), timezone VARCHAR(64), status active|disabled
export const SCHEDULE_STATUSES = ["active", "disabled"] as const;
export const schedulePatchSchema = z
  .object({
    name: boundedString("name", 128).optional(),
    cron: boundedString("cron", 128).optional(),
    timezone: boundedString("timezone", 64).optional(),
    status: z.enum(SCHEDULE_STATUSES, { errorMap: () => ({ message: "status 只能是 active 或 disabled" }) }).optional(),
  })
  .passthrough();

export const scheduleCreateSchema = schedulePatchSchema.omit({ status: true }).extend({ key: boundedString("key", 64).optional() });

/**
 * Effective cron + timezone after a create/patch: timezone first (I-SCH-04: an invalid timezone is reported as a
 * timezone error, not as a cron error), then cron against that timezone. Throws 400 CFG-8501.
 */
export function assertScheduleTiming(cron: string, timezone: string): void {
  if (!isValidTimezone(timezone)) throw errors.invalid("时区无效", { field: "timezone" });
  if (!isValidCron(cron, timezone)) throw errors.invalid("Cron 表达式无效", { field: "cron" });
}
