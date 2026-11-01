import type { PoolConnection } from "mysql2/promise";
import type { CredentialResourceType } from "@forge/contracts";
import { config, credentialHeaderInput, credentialHeaderRefsInput, decryptLegacySecret, errors, loadMasterKeyring, ulidWithPrefix } from "@forge/core";
import { secretsRepo, type CredentialResource } from "./repositories/secrets.js";
import type { ConfigurationAudit } from "./configuration-revision.js";
import { json } from "./db.js";

export interface CredentialInput {
  headers?: unknown;
  headerSecretRefs?: unknown;
  secretId?: string | null;
  value?: string | null;
  legacyEncrypted?: string | null;
}
export type HttpCredentialResourceType = Exclude<CredentialResourceType, "agent" | "message_channel">;

export async function prepareCredentialBindings(connection: PoolConnection, resource: CredentialResource, input: CredentialInput, actor?: ConfigurationAudit, includeDeletedResource = false): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {}, bindings: Record<string, string> = {};
  const scopesToClear: string[] = [], argsToClear: unknown[] = [];
  const inline = async (slot: string, value: string): Promise<string> => {
    const createdBy = actor?.actorType === "user" ? actor.actorId : resource.createdBy;
    const result = await secretsRepo.createSecret({ key: `inline-${ulidWithPrefix("key").toLowerCase()}`, name: `${resource.name} / ${slot}`.slice(0, 128), value,
      scope: { type: "resource", resourceType: resource.type, id: resource.id }, orgUnitId: resource.orgUnitId, createdBy },
    { actorType: actor?.actorType ?? (createdBy ? "user" : "system"), actorId: actor ? actor.actorId ?? null : createdBy, action: "secret.create", resourceType: "secret", resourceId: null, details: { resourceType: resource.type, resourceId: resource.id, bindingKey: slot }, orgUnitId: resource.orgUnitId }, connection, includeDeletedResource);
    return result.id;
  };
  if (input.headers !== undefined || input.headerSecretRefs !== undefined) {
    const values = input.headers === undefined ? {} : credentialHeaderInput(input.headers);
    const refs: Record<string, string> = input.headerSecretRefs === undefined ? Object.create(null) : credentialHeaderRefsInput(input.headerSecretRefs);
    if (Object.keys(values).length + Object.keys(refs).length > 100) throw errors.invalid("请求头总数不能超过100项");
    const empty: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(values)) {
      if (Object.hasOwn(refs, name)) throw errors.invalid("同一请求头不能同时指定值和凭据引用");
      if (value) refs[name] = await inline(`header:${name}`, value);
      else empty.push([name, ""]);
    }
    fields.headers_json = json(Object.fromEntries(empty));
    fields.header_secret_refs_json = json(refs);
    scopesToClear.push("binding_key LIKE 'header:%'");
    for (const [name, id] of Object.entries(refs)) bindings[`header:${name}`] = id;
  }
  if (input.value !== undefined || input.secretId !== undefined || input.legacyEncrypted !== undefined) {
    if (input.value !== undefined && input.secretId !== undefined) throw errors.invalid("凭据值和引用不能同时指定");
    if (input.legacyEncrypted != null && (input.value !== undefined || input.secretId !== undefined)) throw errors.invalid("凭据输入重复");
    const slot = resource.type === "api_app" ? "webhook" : "api-key";
    if (resource.type !== "api_app" && resource.type !== "llm_provider") throw errors.invalid("该资源不支持此凭据槽位");
    let value = input.value;
    if (input.legacyEncrypted) value = decryptLegacySecret(input.legacyEncrypted, loadMasterKeyring(config));
    const id = value ? await inline(slot, value) : input.secretId ?? null;
    fields[resource.type === "api_app" ? "webhook_secret_id" : "secret_id"] = id;
    fields[resource.type === "api_app" ? "webhook_secret_encrypted" : "api_key_encrypted"] = null;
    scopesToClear.push("binding_key = ?"); argsToClear.push(slot);
    if (id) bindings[slot] = id;
  }
  if (scopesToClear.length) {
    // The parent is already locked. Delete existing primary keys only; a missing range DELETE gap-locks new peers.
    const [refs] = await connection.query<import("mysql2/promise").RowDataPacket[]>(`SELECT id FROM resource_references WHERE from_type = ? AND from_id = ? AND to_type = 'secret' AND (${scopesToClear.join(" OR ")})`, [resource.type, resource.id, ...argsToClear]);
    if (refs.length) await connection.execute(`DELETE FROM resource_references WHERE id IN (${refs.map(() => "?").join(",")})`, refs.map(ref => ref.id) as string[]);
    await secretsRepo.bindSecretReferences(resource, bindings, connection, includeDeletedResource);
  }
  return fields;
}

export async function resourceCredentialChanges(type: HttpCredentialResourceType, id: string, fields: Record<string, unknown>, connection: PoolConnection, actor?: ConfigurationAudit): Promise<Record<string, unknown>> {
  if (!["headers_json", "header_secret_refs_json", "secret_id", "api_key", "api_key_encrypted", "webhook_secret", "webhook_secret_id", "webhook_secret_encrypted"].some(key => fields[key] !== undefined)) return {};
  const resource = await secretsRepo.getCredentialResource(type, id, connection);
  if (!resource) throw errors.notFound("资源不存在");
  const input: CredentialInput = {
    headers: fields.headers_json, headerSecretRefs: fields.header_secret_refs_json,
    ...(type === "llm_provider" ? { value: fields.api_key as string | undefined, secretId: fields.secret_id as string | null | undefined, legacyEncrypted: fields.api_key_encrypted as string | null | undefined } : {}),
    ...(type === "api_app" ? { value: fields.webhook_secret as string | undefined, secretId: fields.webhook_secret_id as string | null | undefined, legacyEncrypted: fields.webhook_secret_encrypted as string | null | undefined } : {}),
  };
  return prepareCredentialBindings(connection, resource, input, actor);
}

export async function initializeCredentialBindings(connection: PoolConnection, resource: CredentialResource, input: CredentialInput, audit?: ConfigurationAudit): Promise<void> {
  const fields = await prepareCredentialBindings(connection, resource, input, audit);
  const table = { llm_provider: "llm_providers", mcp_server: "mcp_servers", tool_source: "tool_sources", api_app: "api_apps" }[resource.type as HttpCredentialResourceType];
  if (!table) throw errors.invalid("不支持的凭据资源类型");
  const entries = Object.entries(fields);
  if (entries.length) await connection.execute(`UPDATE ${table} SET ${entries.map(([name]) => `\`${name}\` = ?`).join(", ")} WHERE id = ?`, [...entries.map(([, value]) => value), resource.id] as never[]);
}
