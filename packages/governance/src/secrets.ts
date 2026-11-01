import type {PoolConnection} from "mysql2/promise";
import {resourceFilterFor} from "./resource-access.js";
import {messageConfigRepo} from "@forge/store";
import { assertNoEnvRefs, credentialRedactor, decryptLegacySecret, config, loadMasterKeyring, literalHeaders, storedHeaderSecretRefs, ForgeError, type StoredJsonRef, errors, type Principal } from "@forge/core";
import type { CredentialResourceType, SecretScope, SecretMetadata } from "@forge/contracts";
import { repos, type SecretFilter } from "@forge/store";
import { assertPermission, dataScopeFor } from "./access.js";
import { scopeCoversOrg } from "./audit-scope.js";

export async function secretFilterFor(principal: Principal, connection?: PoolConnection): Promise<SecretFilter> {
  if (principal.type === "app") return {};
  const scope = await dataScopeFor(principal, connection);
  if (scope.all) return { all: true };
  return { orgIds: scope.orgIds, ...(scope.actors.some(a => a.type === principal.type && a.id === principal.id) ? { createdBy: principal.id } : {}) };
}
const RESOURCE_MANAGE: Record<CredentialResourceType, string> = { message_channel:"message.manage", agent: "agent.manage", llm_provider: "model.manage", mcp_server: "mcp.manage", tool_source: "tool.manage", api_app: "apikey.manage" };

export async function validateSecretScope(principal: Principal, scope: SecretScope): Promise<string | null> {
  const access = await dataScopeFor(principal);
  if (scope.type === "platform") {
    if (!access.all) throw errors.forbidden("平台凭据仅允许全部数据范围管理");
    return null;
  }
  if (scope.type === "org") {
    const org = await repos.getOrgUnit(scope.id);
    if (!org || !scopeCoversOrg(access, scope.id)) throw errors.notFound("组织不存在");
    if (org.status !== "active") throw errors.conflict("组织已停用");
    return scope.id;
  }
  assertPermission(principal, RESOURCE_MANAGE[scope.resourceType]);
  if(scope.resourceType==="message_channel" && !await messageConfigRepo.getMessageChannel(scope.id,await resourceFilterFor(principal,"message_channel","manage")))throw errors.notFound("资源不存在");
  const resource = await repos.getCredentialResource(scope.resourceType, scope.id);
  if (!resource || !scopeCoversOrg(access, resource.orgUnitId)) throw errors.notFound("资源不存在");
  return resource.orgUnitId;
}

export async function assertSecretReferences(principal: Principal, ids: readonly string[], connection?: PoolConnection): Promise<void> {
  if (!ids.length) return;
  assertPermission(principal, "secret.manage");
  const filter = await secretFilterFor(principal, connection);
  for (const id of new Set(ids)) if (!(await repos.getSecret(id, filter, connection))) throw errors.notFound("凭据不存在");
}

export async function assertSecretWritable(principal: Principal, secret: SecretMetadata): Promise<void> {
  if ((secret.scope.type === "platform" || secret.orgUnitId === null) && !(await dataScopeFor(principal)).all) throw errors.forbidden("平台凭据仅允许全部数据范围管理");
}

export async function credentialHeaders(type: Exclude<CredentialResourceType, "agent">, id: string, input: { headers: unknown; headerSecretRefs?: unknown; secretId?: string | null; legacyEncrypted?: string | null }, ref: StoredJsonRef) {
  const refs = storedHeaderSecretRefs(input.headerSecretRefs);
  const bindings = Object.fromEntries(Object.entries(refs).map(([name, secretId]) => [`header:${name}`, secretId]));
  if (input.secretId !== undefined && input.secretId !== null) {
    if (!/^[A-Za-z0-9_]{26}$/.test(input.secretId) || type !== "llm_provider") throw new ForgeError("SYS-9002");
    bindings["api-key"] = input.secretId;
  }
  const values = Object.keys(bindings).length ? await repos.resolveCredentialValues(type, id, bindings) : {};
  const headers = Object.fromEntries(Object.entries(literalHeaders(input.headers, ref)).map(([name, value]) => [name.toLowerCase(), value]));
  for (const name of Object.keys(refs)) headers[name] = values[`header:${name}`]!;
  const known = [...Object.values(headers)];
  if (type === "llm_provider") {
    const apiKey = input.secretId ? values["api-key"]! : input.legacyEncrypted ? decryptLegacySecret(input.legacyEncrypted, loadMasterKeyring(config)) : null;
    if (apiKey) { assertNoEnvRefs({ apiKey }); headers.authorization = `Bearer ${apiKey}`; known.push(apiKey, headers.authorization); }
  }
  assertNoEnvRefs({ headers });
  if (Buffer.byteLength(JSON.stringify(headers), "utf8") > 65536) throw new ForgeError("SYS-9002");
  return { headers, redact: credentialRedactor(known) };
}
