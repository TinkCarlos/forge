import { SECRET_SCHEMAS, SECRET_DETAIL_SCHEMA, SECRET_WRITE_SCHEMA } from "./secrets.js";
import { API_ERROR_RESPONSE_SCHEMA } from "./errors.js";
import { IF_MATCH_PARAMETER } from "./configuration.js";

const id = { name: "id", in: "path", required: true, schema: { type: "string", minLength: 26, maxLength: 26 } };
const csrf = { name: "X-CSRF-Token", in: "header", required: true, schema: { type: "string" } };
const failure = (description: string) => ({ description, content: { "application/json": { schema: API_ERROR_RESPONSE_SCHEMA } } });
const operation = (schema: unknown, body?: unknown, parameters: unknown[] = [], conditional = false) => ({
  security: [{ sessionCookie: [] }], "x-permission": "secret.manage", parameters,
  ...(body ? { requestBody: { required: true, content: { "application/json": { schema: body } } } } : {}),
  responses: {
    "200": { description: "仅返回元数据；值只写不读", headers: { "Cache-Control": { schema: { const: "no-store" } }, ...(schema !== SECRET_SCHEMAS.list.response[200] ? { ETag: { schema: IF_MATCH_PARAMETER.schema } } : {}) }, content: { "application/json": { schema } } },
    "400": failure("CFG-8501 输入格式无效"), "401": failure("未登录"), "403": failure("功能权限、数据范围、作用域或CSRF拒绝"), "404": failure("资源不存在或不可见"),
    "409": failure("CFG-8503 版本冲突、凭据已停用或仍被引用"), ...(conditional ? { "428": failure("CFG-8505 缺少If-Match") } : {}), "500": failure("失败关闭；写事务回滚"),
  },
});
export const SECRETS_OPENAPI = {
  openapi: "3.1.0", info: { title: "Forge internal credential vault", version: "0.1.0" }, servers: [{ url: "/admin/api" }],
  components: { securitySchemes: { sessionCookie: { type: "apiKey", in: "cookie", name: "forge_session" } } },
  paths: {
    "/secrets": {
      get: operation(SECRET_SCHEMAS.list.response[200], undefined, Object.entries(SECRET_SCHEMAS.list.querystring.properties).map(([name, schema]) => ({ name, in: "query", required: false, schema }))),
      post: operation(SECRET_WRITE_SCHEMA, SECRET_SCHEMAS.create.body, [csrf]),
    },
    "/secrets/{id}": {
      get: operation(SECRET_DETAIL_SCHEMA, undefined, [id]),
      patch: operation(SECRET_WRITE_SCHEMA, SECRET_SCHEMAS.patch.body, [id, csrf, IF_MATCH_PARAMETER], true),
      delete: operation(SECRET_WRITE_SCHEMA, undefined, [id, csrf, IF_MATCH_PARAMETER], true),
    },
    "/secrets/{id}/rotate": { post: operation(SECRET_WRITE_SCHEMA, SECRET_SCHEMAS.rotate.body, [id, csrf, IF_MATCH_PARAMETER], true) },
  },
};
