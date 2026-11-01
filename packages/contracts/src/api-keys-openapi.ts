import { API_APP_LIST_RESPONSE, API_KEY_CREATE_BODY, API_KEY_LIST_RESPONSE, API_KEY_ROTATE_BODY } from "./api-keys.js";
import { API_ERROR_RESPONSE_SCHEMA } from "./errors.js";

const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
const csrf = { name: "X-CSRF-Token", in: "header", required: true, schema: { type: "string" } };
const result = (properties: Record<string, unknown>, required: string[]) => ({ description: "成功；明文密钥仅在首次成功响应返回", content: { "application/json": { schema: { type: "object", properties, required } } } });
const str = { type: "string" };
const date = { type: ["string", "null"], format: "date-time" };
const metadata = { id: str, prefix: str, expiresAt: date };
const failure = (description: string) => ({ description, content: { "application/json": { schema: API_ERROR_RESPONSE_SCHEMA } } });
const responses = { "400": failure("CFG-8501 输入错误"), "401": failure("AUTH-1001 未登录"), "403": failure("POL-2001 权限/数据范围/CSRF 拒绝"), "404": failure("资源不存在"), "409": failure("密钥不可轮换或 OPN-4503 幂等参数冲突"), "500": failure("失败；事务回滚，安全重试") };
const operation = (body: unknown, parameters: unknown[], success: unknown) => ({ security: [{ sessionCookie: [] }], parameters: [id, csrf, ...parameters], ...(body ? { requestBody: { required: false, content: { "application/json": { schema: body } } } } : {}), responses: { ...responses, "200": success }, "x-permission": "apikey.manage" });
const listOperation = (schema: unknown, parameters: unknown[]) => ({ security: [{ sessionCookie: [] }], parameters, responses: { "200": { description: "元数据及当前调用者可用操作", content: { "application/json": { schema } } }, "401": responses["401"], "403": responses["403"], "404": responses["404"] }, "x-permission": "apikey.view" });

/** This document covers the implemented internal key endpoints, not the whole target Admin API. */
export const API_KEYS_OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Forge internal API Key lifecycle", version: "0.1.0" },
  servers: [{ url: "/admin/api" }],
  components: { securitySchemes: { sessionCookie: { type: "apiKey", in: "cookie", name: "forge_session" } } },
  paths: {
    "/apps": { get: listOperation(API_APP_LIST_RESPONSE, []) },
    "/apps/{id}/keys": { get: listOperation(API_KEY_LIST_RESPONSE, [id]), post: operation(API_KEY_CREATE_BODY, [], result({ ...metadata, key: str, warning: str }, ["id", "key", "prefix", "expiresAt", "warning"])) },
    "/api-keys/{id}/revoke": { post: operation(null, [], result({ ok: { const: true }, appId: str }, ["ok", "appId"])) },
    "/api-keys/{id}/rotate": { post: operation(API_KEY_ROTATE_BODY, [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } }], result({ ...metadata, key: str, secretAvailable: { type: "boolean" }, oldKeyId: str, oldKeyStatus: { enum: ["active", "revoked"] }, oldKeyExpiresAt: date }, ["id", "prefix", "expiresAt", "secretAvailable", "oldKeyId", "oldKeyStatus", "oldKeyExpiresAt"])) },
  },
};
