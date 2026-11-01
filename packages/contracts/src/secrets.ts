export const CREDENTIAL_RESOURCE_TYPES = ["agent", "llm_provider", "mcp_server", "tool_source", "api_app", "message_channel"] as const;
export type CredentialResourceType = (typeof CREDENTIAL_RESOURCE_TYPES)[number];
export type SecretScope = { type: "platform" } | { type: "org"; id: string } | { type: "resource"; resourceType: CredentialResourceType; id: string };
export interface SecretCreateInput { key: string; name: string; description?: string; scope: SecretScope; value: string }
export interface SecretRotateInput { value: string }
export interface SecretPatchInput { name?: string; description?: string; status?: "active" | "disabled" }
export interface SecretMetadata {
  id: string; key: string; name: string; description: string; scope: SecretScope; orgUnitId: string | null;
  status: "active" | "disabled"; revision: number; activeVersionId: string; activeVersion: number; keyVersion: string;
  referenceCount: number; createdBy: string | null; createdAt: string; updatedAt: string;
}
export interface SecretVersionMetadata { id: string; version: number; keyVersion: string; active: boolean; createdBy: string | null; createdAt: string }
export interface SecretReference { resourceType: CredentialResourceType; resourceId: string; bindingKey: string; name: string }
export interface SecretDetail extends SecretMetadata { versions: SecretVersionMetadata[]; references: SecretReference[] }
export interface SecretListResult { items: SecretMetadata[]; nextCursor: string | null }
export interface SecretWriteResult { id: string; revision: number }

const string = (maxLength: number) => ({ type: "string", maxLength }) as const;
const id = { ...string(26), minLength: 26, pattern: "^[A-Za-z0-9_]{26}$" } as const;
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
export const SECRET_SCOPE_SCHEMA = { type: "object", oneOf: [
  object({ type: { type: "string", const: "platform" } }, ["type"]),
  object({ type: { type: "string", const: "org" }, id }, ["type", "id"]),
  object({ type: { type: "string", const: "resource" }, resourceType: { type: "string", enum: CREDENTIAL_RESOURCE_TYPES }, id }, ["type", "resourceType", "id"]),
] } as const;
export const SECRET_VALUE_SCHEMA = { ...string(65536), minLength: 1 } as const;
const nullableId = { anyOf: [id, { type: "null" }] } as const;
const time = { type: "string", format: "date-time" } as const;
const integer = { type: "integer", minimum: 1, maximum: 4294967295 } as const;
const metadataProperties = {
  id, key: string(64), name: string(128), description: string(1024), scope: SECRET_SCOPE_SCHEMA, orgUnitId: nullableId,
  status: { enum: ["active", "disabled"] }, revision: integer, activeVersionId: id, activeVersion: integer, keyVersion: string(64),
  referenceCount: { type: "integer", minimum: 0 }, createdBy: nullableId, createdAt: time, updatedAt: time,
};
export const SECRET_METADATA_SCHEMA = object(metadataProperties, Object.keys(metadataProperties));
export const SECRET_DETAIL_SCHEMA = object({ ...metadataProperties,
  versions: { type: "array", items: object({ id, version: integer, keyVersion: string(64), active: { type: "boolean" }, createdBy: nullableId, createdAt: time }, ["id", "version", "keyVersion", "active", "createdBy", "createdAt"]) },
  references: { type: "array", items: object({ resourceType: { enum: CREDENTIAL_RESOURCE_TYPES }, resourceId: id, bindingKey: string(255), name: string(128) }, ["resourceType", "resourceId", "bindingKey", "name"]) },
}, [...Object.keys(metadataProperties), "versions", "references"]);
export const SECRET_LIST_SCHEMA = object({ items: { type: "array", maxItems: 200, items: SECRET_METADATA_SCHEMA }, nextCursor: nullableId }, ["items", "nextCursor"]);
export const SECRET_WRITE_SCHEMA = object({ id, revision: integer, ok: { const: true } }, ["id", "revision"]);
export const SECRET_SCHEMAS = {
  create: { body: object({ key: { ...string(64), pattern: "^[a-z0-9][a-z0-9._-]{1,63}$" }, name: { ...string(128), minLength: 1 }, description: string(1024), scope: SECRET_SCOPE_SCHEMA, value: SECRET_VALUE_SCHEMA }, ["key", "name", "scope", "value"]), response: { 200: SECRET_WRITE_SCHEMA } },
  rotate: { body: object({ value: SECRET_VALUE_SCHEMA }, ["value"]), response: { 200: SECRET_WRITE_SCHEMA } },
  patch: { body: object({ name: { ...string(128), minLength: 1 }, description: string(1024), status: { type: "string", maxLength: 16, enum: ["active", "disabled"] } }), response: { 200: SECRET_WRITE_SCHEMA } },
  list: { querystring: object({ limit: { type: "string", maxLength: 3, pattern: "^(?:[1-9][0-9]?|1[0-9]{2}|200)$" }, cursor: id }), response: { 200: SECRET_LIST_SCHEMA } },
  remove: { body: object({}), response: { 200: SECRET_WRITE_SCHEMA } },
} as const;
