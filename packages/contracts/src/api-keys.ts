export const API_KEY_CREATE_BODY = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 128 },
    expiresAt: { type: ["string", "null"], maxLength: 40, description: "未来的 RFC3339 时间，必须包含时区；省略或 null 表示永久" },
  },
} as const;

export const API_KEY_ROTATE_BODY = {
  type: "object",
  additionalProperties: false,
  properties: { overlapSeconds: { type: "integer", minimum: 0, maximum: 86400 } },
} as const;

export interface ApiKeyCreateInput { name?: string; expiresAt?: string | null }
export interface ApiKeyCreateResult { id: string; key: string; prefix: string; expiresAt: string | null; warning: string }
export interface ApiKeyRevokeResult { ok: true; appId: string }
export interface ApiKeyRotateInput { overlapSeconds?: number }
export interface ApiKeyRotationResult {
  id: string;
  prefix: string;
  expiresAt: string | null;
  oldKeyId: string;
  oldKeyStatus: "active" | "revoked";
  oldKeyExpiresAt: string | null;
  secretAvailable: boolean;
  key?: string;
}

export interface ApiAppListItem {
  id: string; revision: number; key: string; name: string; status: string; scopes: string[]; webhookUrl: string | null; webhookSecretId: string | null;
  rateLimitPerMinute: number; dailyQuota: number; createdAt: string; canManage: boolean;
}
export interface ApiAppListResult { items: ApiAppListItem[]; canCreate: boolean }
export interface ApiKeyListItem {
  id: string; app_id: string; name: string; prefix: string; scopes_json: string[]; status: string;
  expires_at: string | null; last_used_at: string | null; created_at: string;
}
export interface ApiKeyListResult { items: ApiKeyListItem[]; canManage: boolean }

const text = { type: "string" } as const;
const timestamp = { type: ["string", "null"], format: "date-time" } as const;
const strings = { type: "array", items: text } as const;
const keyProperties = { id: text, app_id: text, name: text, prefix: text, scopes_json: strings, status: text, expires_at: timestamp, last_used_at: timestamp, created_at: { type: "string", format: "date-time" } };
const appProperties = { id: text, revision: { type: "integer", minimum: 1, maximum: 4294967295 }, key: text, name: text, status: text, scopes: strings, webhookUrl: { type: ["string", "null"] }, webhookSecretId: { type: ["string", "null"] }, rateLimitPerMinute: { type: "integer" }, dailyQuota: { type: "integer" }, createdAt: { type: "string", format: "date-time" }, canManage: { type: "boolean" } };
export const API_KEY_LIST_RESPONSE = { type: "object", additionalProperties: false, required: ["items", "canManage"], properties: { canManage: { type: "boolean" }, items: { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(keyProperties), properties: keyProperties } } } } as const;
export const API_APP_LIST_RESPONSE = { type: "object", additionalProperties: false, required: ["items", "canCreate"], properties: { canCreate: { type: "boolean" }, items: { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(appProperties), properties: appProperties } } } } as const;
