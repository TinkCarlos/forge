import { ROUTE_SCHEMAS } from "./route-schemas.js";
import { API_ERROR_RESPONSE_SCHEMA } from "./errors.js";

export interface ConfigurationResult { ok: true; revision: number }
export const REVISION_SCHEMA = { type: "integer", minimum: 1, maximum: 4294967295 } as const;
export interface ConfigurationVersionResult extends ConfigurationResult { versionId: string }
export interface ConfigurationPublishResult extends ConfigurationResult { changed: boolean; publishedVersionId: string }
export interface ConfigurationMcpResult extends ConfigurationResult { tools: Array<{ name: string; description?: string; inputSchema?: unknown; risk?: string; readOnly?: boolean }> }
export const IF_MATCH_PARAMETER = { name: "If-Match", in: "header", required: true, description: '从已读取配置的revision构造单个强标签，例如 "3"；冲突后保留输入，重新读取比较。', schema: { type: "string", pattern: '^"[1-9][0-9]{0,9}"$' } } as const;
export const CONFIGURATION_RESULT = { type: "object", required: ["ok", "revision"], properties: { ok: { const: true }, revision: REVISION_SCHEMA } } as const;
export const CONFIGURATION_VERSION_RESULT = { ...CONFIGURATION_RESULT, required: [...CONFIGURATION_RESULT.required, "versionId"], properties: { ...CONFIGURATION_RESULT.properties, versionId: { type: "string" } } } as const;
export const CONFIGURATION_PUBLISH_RESULT = { ...CONFIGURATION_RESULT, required: [...CONFIGURATION_RESULT.required, "changed", "publishedVersionId"], properties: { ...CONFIGURATION_RESULT.properties, changed: { type: "boolean" }, publishedVersionId: { type: "string" } } } as const;
export const CONFIGURATION_MCP_RESULT = { ...CONFIGURATION_RESULT, required: [...CONFIGURATION_RESULT.required, "tools"], properties: { ...CONFIGURATION_RESULT.properties, tools: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" }, description: { type: "string" }, inputSchema: {}, risk: { type: "string" }, readOnly: { type: "boolean" } } } } } } as const;
export const CONFIGURATION_ROUTES = [
  ["patch", "/agents/{id}", "agentPatch", "agent.manage"],
  ["post", "/agents/{id}/versions", "agentVersionCreate", "agent.publish"],
  ["post", "/agents/{id}/publish", "agentPublish", "agent.publish"],
  ["patch", "/skills/{id}", "skillPatch", "skill.manage"],
  ["post", "/skills/{id}/versions", "skillVersionCreate", "skill.manage"],
  ["patch", "/mcp/{id}", "mcpPatch", "mcp.manage"],
  ["post", "/mcp/{id}/refresh", "noBody", "mcp.manage"],
  ["patch", "/providers/{id}", "providerPatch", "model.manage"],
  ["patch", "/models/{id}", "modelPatch", "model.manage"],
  ["patch", "/apps/{id}", "appPatch", "apikey.manage"],
  ["patch", "/users/{id}", "userPatch", "user.manage"],
  ["patch", "/service-accounts/{id}", "serviceAccountPatch", "service_account.manage"],
  ["patch", "/schedules/{id}", "schedulePatch", "schedule.manage"],
  ["post", "/schedules/{id}/enable", "noBody", "schedule.manage"],
  ["post", "/schedules/{id}/disable", "noBody", "schedule.manage"],
  ["post", "/plugins/{id}/uninstall", "noBody", "plugin.uninstall"],
  ["post", "/role-mappings", "roleMappingUpsert", "sso.manage"],
] as const satisfies readonly (readonly [string, string, keyof typeof ROUTE_SCHEMAS, string])[];

const failure = (description: string) => ({ description, content: { "application/json": { schema: API_ERROR_RESPONSE_SCHEMA } } });
const paths: Record<string, Record<string, unknown>> = {};
for (const [method, path, schema, permission] of CONFIGURATION_ROUTES) {
  const roleMapping = path === "/role-mappings";
  (paths[path] ??= {})[method] = {
    security: [{ sessionCookie: [] }], "x-permission": permission,
    parameters: [
      ...(path.includes("{id}") ? [{ name: "id", in: "path", required: true, schema: { type: "string" } }] : []),
      { name: "X-CSRF-Token", in: "header", required: true, schema: { type: "string" } },
      { ...IF_MATCH_PARAMETER, ...(roleMapping ? { required: false, description: "新code创建不要求If-Match；已有code更新必须携带读取的revision" } : {}) },
    ],
    requestBody: { required: schema !== "noBody", content: { "application/json": { schema: ROUTE_SCHEMAS[schema].body } } },
    responses: {
      "200": { description: "配置写入与审计原子提交；revision为提交版本", headers: { ETag: { schema: IF_MATCH_PARAMETER.schema }, "Cache-Control": { schema: { const: "no-store" } } }, content: { "application/json": { schema: path.endsWith("/versions") ? CONFIGURATION_VERSION_RESULT : path.endsWith("/publish") ? CONFIGURATION_PUBLISH_RESULT : path.endsWith("/refresh") ? CONFIGURATION_MCP_RESULT : CONFIGURATION_RESULT } } },
      "400": failure("CFG-8501 输入或If-Match格式无效"), "401": failure("未登录"), "403": failure("功能、数据范围或CSRF拒绝"), "404": failure("资源不可见或不存在"), "409": failure("CFG-8503 配置已变化；保留草稿并重新读取比较"), "428": failure("CFG-8505 缺少If-Match"), "500": failure("写入失败，事务回滚"),
    },
  };
}
export const CONFIGURATION_OPENAPI = { openapi: "3.1.0", info: { title: "Forge internal configuration writes", version: "0.1.0" }, servers: [{ url: "/admin/api" }], components: { securitySchemes: { sessionCookie: { type: "apiKey", in: "cookie", name: "forge_session" } } }, paths };
