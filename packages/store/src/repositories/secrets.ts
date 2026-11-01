import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { config, validateSecretValue, validateCredentialHeader, errors, ForgeError, loadMasterKeyring, MAX_REVISION, openSecret, sealSecret, ulidWithPrefix, type SecretContext, type SecretEnvelope } from "@forge/core";
import type { CredentialResourceType, SecretDetail, SecretMetadata, SecretScope, SecretVersionMetadata, SecretWriteResult } from "@forge/contracts";
import { query, transaction } from "../db.js";
import { updateConfiguration, type ConfigurationAudit, type ConfigurationWrite } from "../configuration-revision.js";
import { auditRepo } from "./audit.js";

export interface SecretFilter { all?: boolean; orgIds?: readonly string[]; createdBy?: string }
export interface CredentialResource { type: CredentialResourceType; id: string; orgUnitId: string | null; name: string; createdBy: string | null }
export interface SecretRow extends RowDataPacket {
  id: string; key: string; name: string; description: string; scope_type: string; scope_id: string; scope_resource_type: string;
  owner_org_unit_id: string | null; active_version_id: string | null; status: string; revision: number; created_by: string | null; created_at: Date; updated_at: Date;
}
interface MaterialRow extends SecretRow {
  version_id: string; version: number; key_version: string; ciphertext: Buffer; nonce: Buffer; tag: Buffer; encrypted_dek: Buffer; dek_nonce: Buffer; dek_tag: Buffer;
}
const RESOURCE_TABLES: Record<CredentialResourceType, { table: string; owner: string; deleted?: boolean; statusDeleted?: boolean }> = {
  message_channel: { table:"message_channels", owner:"owner_org_unit_id", statusDeleted:true },
  agent: { table: "agents", owner: "owner_org_unit_id", deleted: true }, llm_provider: { table: "llm_providers", owner: "NULL" },
  mcp_server: { table: "mcp_servers", owner: "NULL", deleted: true }, tool_source: { table: "tool_sources", owner: "NULL" }, api_app: { table: "api_apps", owner: "owner_org_unit_id" },
};
function scopeColumns(scope: SecretScope) { return { type: scope.type, id: scope.type === "platform" ? "" : scope.id, resourceType: scope.type === "resource" ? scope.resourceType : "" }; }
function scopeOf(row: SecretRow): SecretScope {
  if (row.scope_type === "platform") return { type: "platform" };
  if (row.scope_type === "org") return { type: "org", id: row.scope_id };
  if (row.scope_type === "resource" && Object.hasOwn(RESOURCE_TABLES, row.scope_resource_type)) return { type: "resource", resourceType: row.scope_resource_type as CredentialResourceType, id: row.scope_id };
  throw new ForgeError("SYS-9002");
}
function context(row: SecretRow, version: number): SecretContext { return { secretId: row.id, version, scopeType: row.scope_type, scopeId: row.scope_id, scopeResourceType: row.scope_resource_type }; }
function envelope(row: MaterialRow): SecretEnvelope { return { ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag, encryptedDek: row.encrypted_dek, dekNonce: row.dek_nonce, dekTag: row.dek_tag, keyVersion: row.key_version }; }
function visible(filter: SecretFilter, alias = "s"): { sql: string; args: unknown[] } {
  if (filter.all) return { sql: "1=1", args: [] };
  const clauses: string[] = [], args: unknown[] = [];
  if (filter.orgIds?.length) { clauses.push(`${alias}.owner_org_unit_id IN (${filter.orgIds.map(() => "?").join(",")})`); args.push(...filter.orgIds); }
  if (filter.createdBy) { clauses.push(`${alias}.created_by = ?`); args.push(filter.createdBy); }
  return { sql: clauses.length ? `(${clauses.join(" OR ")})` : "0=1", args };
}
const META_SELECT = `SELECT s.*, v.version AS active_version, v.key_version,
 (SELECT COUNT(*) FROM resource_references r WHERE r.to_type = 'secret' AND r.to_id = s.id) AS reference_count
 FROM secrets s JOIN secret_versions v ON v.id = s.active_version_id AND v.secret_id = s.id`;
function metadata(row: SecretRow): SecretMetadata {
  return { id: row.id, key: row.key, name: row.name, description: row.description, scope: scopeOf(row), orgUnitId: row.owner_org_unit_id,
    status: row.status as "active" | "disabled", revision: row.revision, activeVersionId: row.active_version_id!, activeVersion: Number(row.active_version), keyVersion: String(row.key_version), referenceCount: Number(row.reference_count), createdBy: row.created_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
export function assertSecretScope(row: SecretRow, resource: CredentialResource): void {
  if (row.status !== "active") throw new ForgeError("SYS-9002");
  const scope = scopeOf(row);
  if (scope.type === "platform" || (scope.type === "org" && scope.id === resource.orgUnitId) || (scope.type === "resource" && scope.resourceType === resource.type && scope.id === resource.id)) return;
  throw new ForgeError("SYS-9002");
}
async function insertVersion(conn: PoolConnection, row: SecretRow, versionId: string, version: number, value: string, createdBy: string | null): Promise<void> {
  const sealed = sealSecret(value, context(row, version), loadMasterKeyring(config));
  await conn.execute("INSERT INTO secret_versions (id, secret_id, version, ciphertext, nonce, tag, encrypted_dek, dek_nonce, dek_tag, key_version, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [versionId, row.id, version, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.encryptedDek, sealed.dekNonce, sealed.dekTag, sealed.keyVersion, createdBy]);
}
async function lockSecret(conn: PoolConnection, id: string): Promise<SecretRow> {
  const [rows] = await conn.query<SecretRow[]>("SELECT * FROM secrets WHERE id = ? FOR UPDATE", [id]);
  if (!rows[0] || rows[0].status === "deleted") throw errors.notFound("凭据不存在");
  return rows[0];
}

export const secretsRepo = {
  async getCredentialResource(type: CredentialResourceType, id: string, connection?: PoolConnection, includeDeleted = false): Promise<CredentialResource | null> {
    if (!Object.hasOwn(RESOURCE_TABLES, type)) throw errors.invalid("不支持的凭据资源类型");
    const source = RESOURCE_TABLES[type];
    const sql = `SELECT id, name, created_by, ${source.owner} AS owner_org_unit_id FROM ${source.table} WHERE id = ?${source.deleted && !includeDeleted ? " AND deleted_at IS NULL" : source.statusDeleted && !includeDeleted ? " AND status <> 'deleted'" : ""}`;
    const rows = connection ? (await connection.query<SecretRow[]>(`${sql} FOR UPDATE`, [id]))[0] : await query<SecretRow>(sql, [id]);
    return rows[0] ? { type, id, name: rows[0].name, orgUnitId: rows[0].owner_org_unit_id, createdBy: rows[0].created_by } : null;
  },
  async listSecrets(filter: SecretFilter, input: { limit?: number; cursor?: string } = {}) {
    const access = visible(filter), limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 200));
    const rows = await query<SecretRow>(`${META_SELECT} WHERE s.status <> 'deleted' AND ${access.sql}${input.cursor ? " AND s.id < ?" : ""} ORDER BY s.id DESC LIMIT ?`, [...access.args, ...(input.cursor ? [input.cursor] : []), limit + 1]);
    return { items: rows.slice(0, limit).map(metadata), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
  },
  async getSecret(id: string, filter: SecretFilter, connection?: PoolConnection): Promise<SecretMetadata | null> {
    const access = visible(filter);
    const rows = await query<SecretRow>(`${META_SELECT} WHERE s.id = ? AND s.status <> 'deleted' AND ${access.sql}`, [id, ...access.args], connection);
    return rows[0] ? metadata(rows[0]) : null;
  },
  async getSecretDetail(id: string, filter: SecretFilter): Promise<SecretDetail | null> {
    const meta = await secretsRepo.getSecret(id, filter);
    if (!meta) return null;
    const versions = await query<{ id: string; version: number; key_version: string; created_by: string | null; created_at: Date }>("SELECT id, version, key_version, created_by, created_at FROM secret_versions WHERE secret_id = ? ORDER BY version DESC", [id]);
    const access = visible(filter, "p");
    const refs = await query<{ from_type: CredentialResourceType; from_id: string; binding_key: string; name: string }>(`SELECT p.from_type, p.from_id, p.binding_key, p.name FROM (
      SELECT r.from_type, r.from_id, r.binding_key, COALESCE(a.name, l.name, m.name, t.name, ap.name, ch.name) AS name,
        COALESCE(a.owner_org_unit_id, ap.owner_org_unit_id, ch.owner_org_unit_id) AS owner_org_unit_id,
        COALESCE(a.created_by, l.created_by, m.created_by, t.created_by, ap.created_by, ch.created_by) AS created_by
      FROM resource_references r
      LEFT JOIN agents a ON r.from_type = 'agent' AND a.id = r.from_id AND a.deleted_at IS NULL
      LEFT JOIN llm_providers l ON r.from_type = 'llm_provider' AND l.id = r.from_id
      LEFT JOIN mcp_servers m ON r.from_type = 'mcp_server' AND m.id = r.from_id AND m.deleted_at IS NULL
      LEFT JOIN tool_sources t ON r.from_type = 'tool_source' AND t.id = r.from_id
      LEFT JOIN api_apps ap ON r.from_type = 'api_app' AND ap.id = r.from_id
      LEFT JOIN message_channels ch ON r.from_type = 'message_channel' AND ch.id = r.from_id AND ch.status <> 'deleted'
      WHERE r.to_type = 'secret' AND r.to_id = ?
    ) p WHERE p.name IS NOT NULL AND ${access.sql} ORDER BY p.from_type, p.from_id, p.binding_key`, [id, ...access.args]);
    const references = refs.map(ref => ({ resourceType: ref.from_type, resourceId: ref.from_id, bindingKey: ref.binding_key, name: ref.name }));
    return { ...meta, references, versions: versions.map((v): SecretVersionMetadata => ({ id: v.id, version: v.version, keyVersion: v.key_version, active: v.id === meta.activeVersionId, createdBy: v.created_by, createdAt: v.created_at.toISOString() })) };
  },
  async createSecret(input: { key: string; name: string; description?: string; scope: SecretScope; orgUnitId: string | null; value: string; createdBy?: string | null }, audit?: ConfigurationAudit, connection?: PoolConnection, includeDeletedResource = false): Promise<SecretWriteResult> {
    validateSecretValue(input.value);
    const id = ulidWithPrefix("sec"), versionId = ulidWithPrefix("scv"), scope = scopeColumns(input.scope);
    const write = async (conn: PoolConnection) => {
      if (input.scope.type === "resource") {
        const resource = await secretsRepo.getCredentialResource(input.scope.resourceType, input.scope.id, conn, includeDeletedResource);
        if (!resource || resource.orgUnitId !== input.orgUnitId) throw errors.conflict("凭据资源归属已变化，请重新读取");
      } else if (input.scope.type === "org") {
        const [orgs] = await conn.query<RowDataPacket[]>("SELECT id, status FROM org_units WHERE id = ? FOR SHARE", [input.scope.id]);
        if (!orgs[0] || orgs[0].status !== "active" || input.orgUnitId !== input.scope.id) throw errors.conflict("凭据组织归属已变化，请重新读取");
      } else if (input.orgUnitId !== null) throw errors.invalid("平台凭据不能指定组织");
      await conn.execute("INSERT INTO secrets (id, `key`, name, description, scope_type, scope_id, scope_resource_type, owner_org_unit_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, input.key, input.name, input.description ?? "", scope.type, scope.id, scope.resourceType, input.orgUnitId, input.createdBy ?? null]);
      const row = await lockSecret(conn, id);
      await insertVersion(conn, row, versionId, 1, input.value, input.createdBy ?? null);
      await conn.execute("UPDATE secrets SET active_version_id = ? WHERE id = ?", [versionId, id]);
      if (audit) await auditRepo.audit({ ...audit, resourceId: id }, conn);
      return { id, revision: 1 };
    };
    return connection ? write(connection) : transaction(write);
  },
  async updateSecret(id: string, fields: { name?: string; description?: string; status?: "active" | "disabled" }, options: ConfigurationWrite): Promise<number> {
    return updateConfiguration("secrets", id, fields, { ...options, beforeWrite: async conn => { await lockSecret(conn, id); if (options.beforeWrite) await options.beforeWrite(conn); } });
  },
  async rotateSecret(id: string, value: string, options: ConfigurationWrite): Promise<number> {
    validateSecretValue(value);
    const versionId = ulidWithPrefix("scv");
    return updateConfiguration("secrets", id, { active_version_id: versionId }, { ...options, beforeWrite: async conn => {
      const row = await lockSecret(conn, id);
      const [versions] = await conn.query<RowDataPacket[]>("SELECT MAX(version) n FROM secret_versions WHERE secret_id = ?", [id]);
      const [endpoints] = await conn.query<RowDataPacket[]>("SELECT 1 FROM resource_references WHERE to_type='secret' AND to_id=? AND binding_key LIKE 'endpoint-version:%' LIMIT 1",[id]);
      if(endpoints.length)throw errors.conflict("渠道地址快照不可轮换，请修改渠道地址");
      const next = Number(versions[0]!.n ?? 0) + 1;
      if (next > MAX_REVISION) throw errors.conflict("凭据版本已达到上限");
      const [headerRefs] = await conn.query<RowDataPacket[]>("SELECT 1 FROM resource_references WHERE to_type = 'secret' AND to_id = ? AND (binding_key = 'api-key' OR binding_key LIKE 'header:%') LIMIT 1", [id]);
      if (headerRefs.length) validateCredentialHeader(value);
      await insertVersion(conn, row, versionId, next, value, options.audit?.actorId ?? null);
      if (options.beforeWrite) await options.beforeWrite(conn);
    } });
  },
  async deleteSecret(id: string, options: ConfigurationWrite): Promise<number> {
    return updateConfiguration("secrets", id, { status: "deleted", deleted_at: new Date() }, { ...options, beforeWrite: async conn => {
      await lockSecret(conn, id);
      const [refs] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) n FROM resource_references WHERE to_type = 'secret' AND to_id = ?", [id]);
      if (Number(refs[0]!.n)) throw errors.conflict("凭据仍被资源引用，无法删除");
      if (options.beforeWrite) await options.beforeWrite(conn);
    } });
  },
  async bindSecretReferences(resource: CredentialResource, bindings: Record<string, string>, connection: PoolConnection, includeDeletedResource = false): Promise<void> {
    const actual = await secretsRepo.getCredentialResource(resource.type, resource.id, connection, includeDeletedResource);
    if (!actual || actual.orgUnitId !== resource.orgUnitId) throw errors.conflict("凭据资源归属已变化，请重新读取");
    const secrets = new Map<string, SecretRow>();
    for (const id of [...new Set(Object.values(bindings))].sort()) {
      const row = await lockSecret(connection, id);
      if (row.status !== "active") throw errors.conflict("凭据已停用");
      try { assertSecretScope(row, resource); } catch { throw errors.forbidden("凭据作用域不允许此资源使用"); }
      secrets.set(id, row);
    }
    for (const [slot, id] of Object.entries(bindings)) {
      if (slot === "api-key" || slot.startsWith("header:")) {
        const [materials] = await connection.query<MaterialRow[]>("SELECT s.*, v.id version_id, v.version, v.key_version, v.ciphertext, v.nonce, v.tag, v.encrypted_dek, v.dek_nonce, v.dek_tag FROM secrets s JOIN secret_versions v ON v.id = s.active_version_id AND v.secret_id = s.id WHERE s.id = ?", [id]);
        const row = materials[0]; if (!row) throw new ForgeError("SYS-9002");
        validateCredentialHeader(openSecret(envelope(row), context(row, row.version), loadMasterKeyring(config)));
      }
      if (!slot || slot.length > 255) throw errors.invalid("凭据绑定名称无效");
      const target = secrets.get(id)!;
      await connection.execute("INSERT INTO resource_references (id, from_type, from_id, to_type, to_id, to_key, binding_key) VALUES (?, ?, ?, 'secret', ?, ?, ?) ON DUPLICATE KEY UPDATE to_id = VALUES(to_id), to_key = VALUES(to_key)", [ulidWithPrefix("ref"), resource.type, resource.id, id, target.key, slot]);
    }
  },
  async resolveCredentialValues(type: CredentialResourceType, id: string, bindings: Record<string, string>, connection?: PoolConnection): Promise<Record<string, string>> {
    const slots = Object.keys(bindings);
    if (!slots.length) return {};
    const resource = await secretsRepo.getCredentialResource(type, id, connection);
    if (!resource) throw new ForgeError("SYS-9002");
    const rows = await query<MaterialRow>(`SELECT s.*, v.id version_id, v.version, v.key_version, v.ciphertext, v.nonce, v.tag, v.encrypted_dek, v.dek_nonce, v.dek_tag, r.binding_key FROM resource_references r JOIN secrets s ON s.id = r.to_id JOIN secret_versions v ON v.id = s.active_version_id AND v.secret_id = s.id WHERE r.from_type = ? AND r.from_id = ? AND r.to_type = 'secret' AND r.binding_key IN (${slots.map(() => "?").join(",")})`, [type, id, ...slots], connection);
    if (rows.length !== slots.length) throw new ForgeError("SYS-9002");
    const ring = loadMasterKeyring(config), result: Record<string, string> = {};
    for (const row of rows) {
      const slot = String(row.binding_key);
      if (bindings[slot] !== row.id) throw new ForgeError("SYS-9002");
      assertSecretScope(row, resource);
      const value = openSecret(envelope(row), context(row, row.version), ring);
      if (slot === "api-key" || slot.startsWith("header:")) validateCredentialHeader(value);
      result[slot] = value;
    }
    return result;
  },
};
