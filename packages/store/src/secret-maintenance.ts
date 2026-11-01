import type { RowDataPacket } from "mysql2/promise";
import { config, credentialHeaderInput, decryptLegacySecret, ForgeError, loadMasterKeyring, openSecret, rewrapSecret, storedHeaderSecretRefs, type SecretEnvelope } from "@forge/core";
import { query, transaction } from "./db.js";
import { updateConfiguration } from "./configuration-revision.js";
import { prepareCredentialBindings, type CredentialInput, type HttpCredentialResourceType } from "./credential-bindings.js";
import { secretsRepo } from "./repositories/secrets.js";
import { auditRepo } from "./repositories/audit.js";

const TABLES = { llm_provider: "llm_providers", mcp_server: "mcp_servers", tool_source: "tool_sources", api_app: "api_apps" } as const;
export interface SecretMaintenanceReport { scanned: number; changed: number; failed: number }
export interface SecretMaintenanceFailure { resourceType: string; id: string; code: string }
type ReportFailure = (failure: SecretMaintenanceFailure) => void;

/** Lock and re-read the parent: a concurrent edit must never be replaced with an earlier scan result. */
export async function migrateResourceCredentials(type: HttpCredentialResourceType, id: string): Promise<boolean> {
  return transaction(async conn => {
    // Historical rows must lose plaintext too; the normal runtime lookup continues to hide deleted resources.
    const resource = await secretsRepo.getCredentialResource(type, id, conn, true);
    if (!resource) return false;
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${TABLES[type]} WHERE id = ?`, [id]);
    const row = rows[0]!, input: CredentialInput = {};
    if (type !== "api_app") {
      const headers = credentialHeaderInput(row.headers_json ?? {}), refs = storedHeaderSecretRefs(row.header_secret_refs_json);
      if (row.header_secret_refs_json === null || Object.values(headers).some(Boolean)) {
        // A saved reference is authoritative; remove any legacy residue rather than restoring an old value.
        input.headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !Object.hasOwn(refs, name)));
        input.headerSecretRefs = refs;
      }
    }
    const legacy = type === "api_app" ? row.webhook_secret_encrypted : type === "llm_provider" ? row.api_key_encrypted : null;
    if (legacy !== null && legacy !== undefined) {
      if (typeof legacy !== "string" || !legacy) throw new ForgeError("SYS-9002");
      const value = decryptLegacySecret(legacy, loadMasterKeyring(config));
      const existing = type === "api_app" ? row.webhook_secret_id : row.secret_id;
      if (existing) input.secretId = String(existing);
      else input.value = value;
    }
    if (!Object.keys(input).length) return false;
    const audit = { actorType: "system", actorId: null, action: "secret.migrate", resourceType: type, resourceId: id, orgUnitId: resource.orgUnitId };
    await updateConfiguration(TABLES[type], id, () => prepareCredentialBindings(conn, resource, input, audit, true), {
      expectedRevision: "system", connection: conn,
      audit,
    });
    return true;
  });
}

export async function migrateLegacyCredentials(report: ReportFailure): Promise<SecretMaintenanceReport> {
  const result = { scanned: 0, changed: 0, failed: 0 };
  for (const [type, table] of Object.entries(TABLES) as Array<[HttpCredentialResourceType, string]>) {
    let cursor = "";
    for (;;) {
      const rows = await query<{ id: string }>(`SELECT id FROM ${table} WHERE id > ? ORDER BY id LIMIT 100`, [cursor]);
      if (!rows.length) break;
      for (const row of rows) {
        result.scanned++;
        try { if (await migrateResourceCredentials(type, row.id)) result.changed++; }
        catch (error) { result.failed++; report({ resourceType: type, id: row.id, code: error instanceof ForgeError ? error.code : "SYS-9001" }); }
      }
      cursor = rows.at(-1)!.id;
    }
  }
  return result;
}

interface VersionRow extends RowDataPacket { id: string; secret_id: string; version: number; key_version: string; ciphertext: Buffer; nonce: Buffer; tag: Buffer; encrypted_dek: Buffer; dek_nonce: Buffer; dek_tag: Buffer }
export async function rewrapSecretVersion(id: string, targetVersion: string): Promise<boolean> {
  return transaction(async conn => {
    // Lock only the version. Rotation locks parent -> version; do not introduce the reverse order.
    const [rows] = await conn.query<VersionRow[]>("SELECT * FROM secret_versions WHERE id = ? FOR UPDATE", [id]);
    const row = rows[0];
    if (!row) return false;
    const [parents] = await conn.query<RowDataPacket[]>("SELECT scope_type, scope_id, scope_resource_type, owner_org_unit_id FROM secrets WHERE id = ?", [row.secret_id]);
    const parent = parents[0]; if (!parent) throw new ForgeError("SYS-9002");
    const ring = loadMasterKeyring(config);
    if (ring.activeVersion !== targetVersion) throw new ForgeError("SYS-9002");
    const context = { secretId: row.secret_id, version: row.version, scopeType: String(parent.scope_type), scopeId: String(parent.scope_id), scopeResourceType: String(parent.scope_resource_type) };
    const envelope: SecretEnvelope = { ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag, encryptedDek: row.encrypted_dek, dekNonce: row.dek_nonce, dekTag: row.dek_tag, keyVersion: row.key_version };
    if (row.key_version === targetVersion) { openSecret(envelope, context, ring); return false; }
    const wrapped = rewrapSecret(envelope, context, ring);
    await conn.execute("UPDATE secret_versions SET encrypted_dek = ?, dek_nonce = ?, dek_tag = ?, key_version = ? WHERE id = ?", [wrapped.encryptedDek, wrapped.dekNonce, wrapped.dekTag, wrapped.keyVersion, id]);
    await auditRepo.audit({ actorType: "system", actorId: null, action: "secret.rewrap", resourceType: "secret", resourceId: row.secret_id, orgUnitId: parent.owner_org_unit_id as string | null,
      details: { version: row.version, fromKeyVersion: row.key_version, toKeyVersion: targetVersion } }, conn);
    return true;
  });
}

export async function rewrapSecretVersions(report: ReportFailure): Promise<SecretMaintenanceReport & { keyVersions: Array<{ keyVersion: string; count: number }>; legacyCiphertexts: number }> {
  const target = loadMasterKeyring(config).activeVersion, result = { scanned: 0, changed: 0, failed: 0 };
  let cursor = "";
  for (;;) {
    const rows = await query<{ id: string }>("SELECT id FROM secret_versions WHERE id > ? ORDER BY id LIMIT 100", [cursor]);
    if (!rows.length) break;
    for (const row of rows) {
      result.scanned++;
      try { if (await rewrapSecretVersion(row.id, target)) result.changed++; }
      catch (error) { result.failed++; report({ resourceType: "secret_version", id: row.id, code: error instanceof ForgeError ? error.code : "SYS-9001" }); }
    }
    cursor = rows.at(-1)!.id;
  }
  const counts = await query<{ key_version: string; n: number }>("SELECT key_version, COUNT(*) n FROM secret_versions GROUP BY key_version ORDER BY key_version");
  const legacy = await query<{ n: number }>("SELECT (SELECT COUNT(*) FROM llm_providers WHERE api_key_encrypted IS NOT NULL) + (SELECT COUNT(*) FROM api_apps WHERE webhook_secret_encrypted IS NOT NULL) n");
  return { ...result, keyVersions: counts.map(row => ({ keyVersion: row.key_version, count: Number(row.n) })), legacyCiphertexts: Number(legacy[0]!.n) };
}
