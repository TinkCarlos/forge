import { ForgeError } from "./errors/forge-error.js";
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";

export * from "./config";
export * from "./outbound";
export * from "./env-ref";
export * from "./cron";
export * from "./ids";
export * from "./id-generator.js";
export * from "./revision.js";
export * from "./secret-encryption.js";
export * from "./credential-input.js";
export * from "./credential-redaction.js";
export * from "./stored-json";
export * from "./sso-error-codes";
export * from "./errors/index.js";

/** User status values written by the code (T): login / loadActivePrincipal only accept "active". */
export const USER_STATUSES = ["active", "disabled"] as const;
export { accountText, assertAccountPassword } from "./account-input.js";
/** Skill status values (K-12 / I-SKL-07): getPublishedSkillContent only serves "active". */
export const SKILL_STATUSES = ["active", "disabled"] as const;

export type Role = string;
export * from "./auth/permissions.js";
export type DataScope = "all" | "org" | "self" | "app";

export interface Principal {
  revision?: number;
  /** Only used between credential verification and session creation; never sent to clients. */
  authenticationRevision?: number;
  permissions?: readonly string[];
  grantedPermissions?: readonly string[];
  type: "user" | "service" | "app";
  id: string;
  name: string;
  role: Role;
  orgUnitId: string | null;
  dataScope: DataScope;
  appId?: string;
  scopes?: string[];
}

export const OUTPUT_REPAIR_PREFIX = "Output validation failed";

export interface AgentSpec {
  model: {
    provider: string;
    model: string;
    fallbackProvider?: string;
    fallbackModel?: string;
    route?: string | null;
    temperature?: number;
    maxTokens?: number;
  };
  skills?: string[];
  toolsets?: Array<
    | { builtin: string[] }
    | { mcp: string; allow?: string[] }
    | { openapi: string; allow?: string[] }
    | { connector: string; allow?: string[] }
  >;
  limits?: {
    maxSteps?: number;
    maxCostUsd?: number;
    maxOutputRetries?: number;
    maxContextTokens?: number;
    maxParallelTools?: number;
  };
  approval?: { tools?: string[]; timeoutSeconds?: number };
  output?: { schema?: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: "low" | "medium" | "high";
}

export interface ToolResult {
  ok: boolean;
  content: string;
  durationMs?: number;
  errorCode?: string;
}

export const STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
] as const;
export type RunStatus = (typeof STATUSES)[number];

export function defaultDataScope(role: Role): DataScope {
  if (role === "platform_admin" || role === "auditor") return "all";
  if (role !== "org_admin" && role !== "builder" && role !== "operator") return "self";
  return "org";
}

/** 409 on deciding an approval that is not pending any more, lost a concurrent decision, or expired (r5 §2.7). */
export const APPROVAL_NOT_PENDING_CODE = "APR-2104";
/** Run failed because its approval expired longer than APPROVAL_EXPIRED_GRACE_SECONDS ago (r5 §2.6). */
export const APPROVAL_EXPIRED_CODE = "APR-2102";

export const errors = {
  unauthorized: (message = "未登录或会话已过期") => new ForgeError("AUTH-1001", { message: message, httpStatus: 401, retryable: false }),
  forbidden: (message = "没有权限执行该操作") => new ForgeError("POL-2001", { message: message, httpStatus: 403, retryable: false }),
  notFound: (message = "资源不存在") => new ForgeError("RUN-7001", { message: message, httpStatus: 404, retryable: false }),
  invalid: (message = "参数校验失败", details?: unknown) => new ForgeError("CFG-8501", { message: message, httpStatus: 400, details: details, retryable: false }),
  conflict: (message = "资源状态冲突") => new ForgeError("CFG-8503", { message: message, httpStatus: 409, retryable: false }),
  model: (message = "模型调用失败", details?: unknown) => new ForgeError("MDL-3001", { message: message, httpStatus: 502, details: details, retryable: true }),
  tool: (message = "工具调用失败", details?: unknown) => new ForgeError("HTP-4001", { message: message, httpStatus: 502, details: details, retryable: false }),
  /** Infrastructure temporarily unavailable (e.g. the database during an identity lookup): 503, retryable, no internal details. */
  unavailable: (message = "服务暂时不可用，请稍后重试") => new ForgeError("SYS-9003", { message: message, httpStatus: 503, retryable: true }),
  budget: (message = "预算已耗尽") => new ForgeError("BUD-5001", { message: message, httpStatus: 400, retryable: false }),
};

export function hashApiKey(key: string, pepper: string): string {
  return createHmac("sha256", pepper).update(key).digest("hex");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function isPasswordHash(value: unknown): value is string {
  return typeof value === "string" && /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(value);
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!isPasswordHash(stored)) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = parts[1]!;
  const expected = Buffer.from(parts[2]!, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function encryptSecret(plain: string, keyB64: string): string {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64")}.${ciphertext.toString("base64")}.${tag.toString("base64")}`;
}

export function decryptSecret(payload: string, keyB64: string): string {
  const [version, ivB64, ciphertextB64, tagB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !ciphertextB64 || !tagB64) throw new ForgeError("SYS-9002", { message: "invalid encrypted secret" });
  const key = Buffer.from(keyB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]).toString("utf8");
}

export function signSession(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
export * from "./query-filter.js";
