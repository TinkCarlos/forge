import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";
import { ulid } from "ulid";

export * from "./config";

export type Role = "platform_admin" | "org_admin" | "builder" | "operator" | "auditor" | "user";
export type DataScope = "all" | "org" | "self" | "app";

export interface Principal {
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

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  platform_admin: ["*"],
  org_admin: [
    "agent.view",
    "agent.manage",
    "agent.publish",
    "agent.run",
    "skill.view",
    "skill.manage",
    "mcp.view",
    "mcp.manage",
    "tool.view",
    "tool.manage",
    "model.view",
    "model.manage",
    "run.view",
    "run.cancel",
    "approval.view",
    "approval.decide",
    "schedule.view",
    "schedule.manage",
    "schedule.run",
    "apikey.view",
    "apikey.manage",
    "plugin.install",
    "user.view",
    "user.manage",
    "audit.view",
    "usage.view",
  ],
  builder: [
    "agent.view",
    "agent.manage",
    "agent.publish",
    "agent.run",
    "skill.view",
    "skill.manage",
    "mcp.view",
    "mcp.manage",
    "tool.view",
    "tool.manage",
    "model.view",
    "model.manage",
    "run.view",
    "schedule.view",
    "schedule.manage",
    "schedule.run",
    "plugin.install",
    "usage.view",
  ],
  operator: [
    "agent.view",
    "agent.run",
    "run.view",
    "run.cancel",
    "approval.view",
    "approval.decide",
    "schedule.view",
    "schedule.run",
  ],
  auditor: ["run.view", "audit.view", "usage.view", "agent.view"],
  user: ["agent.view", "agent.run", "run.view"],
};

export function hasPermission(role: Role, permission: string): boolean {
  const list = ROLE_PERMISSIONS[role] ?? [];
  return list.includes("*") || list.includes(permission);
}

export function defaultDataScope(role: Role): DataScope {
  if (role === "platform_admin" || role === "auditor") return "all";
  if (role === "user") return "self";
  return "org";
}

export class ForgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
    public readonly details?: unknown,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ForgeError";
  }
}

export const errors = {
  unauthorized: (message = "未登录或会话已过期") => new ForgeError("AUTH-1001", message, 401),
  forbidden: (message = "没有权限执行该操作") => new ForgeError("POL-2001", message, 403),
  notFound: (message = "资源不存在") => new ForgeError("RUN-7001", message, 404),
  invalid: (message = "参数校验失败", details?: unknown) => new ForgeError("CFG-8501", message, 400, details),
  conflict: (message = "资源状态冲突") => new ForgeError("CFG-8503", message, 409),
  model: (message = "模型调用失败", details?: unknown) => new ForgeError("MDL-3001", message, 502, details, true),
  tool: (message = "工具调用失败", details?: unknown) => new ForgeError("HTP-4001", message, 502, details, false),
  budget: (message = "预算已耗尽") => new ForgeError("BUD-5001", message, 400),
};

export function ulidWithPrefix(prefix: string): string {
  const raw = ulid();
  const suffix = raw.slice(0, 26 - prefix.length - 1);
  return `${prefix}_${suffix}`;
}

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

export function verifyPassword(password: string, stored: string): boolean {
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
  if (version !== "v1" || !ivB64 || !ciphertextB64 || !tagB64) throw new Error("invalid encrypted secret");
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
