import { authorizationSql } from "./authorization-sql.js";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { config, errors, isPasswordHash } from "@forge/core";
import type { ConfigurationWrite } from "./configuration-revision.js";
import type { RoleRow, UserRow } from "./types.js";

export interface AccountWrite extends ConfigurationWrite {
  roleMappingRevision?: string;
  authorize?: (target: UserRow | null, actor: UserRow | null, roles: RoleRow[] | undefined, connection: PoolConnection) => Promise<void>;
}

/** All account writers take this lock before user locks, including SSO JIT and explicit binding. */
export async function lockAccounts(conn: PoolConnection): Promise<void> {
  await conn.execute("INSERT INTO settings (`key`, value_json) VALUES ('identity.account-lock', '{}') ON DUPLICATE KEY UPDATE value_json = value_json");
  await conn.query("SELECT `key` FROM settings WHERE `key` = 'identity.account-lock' FOR UPDATE");
}

export async function lockedUser(conn: PoolConnection, id: string): Promise<UserRow | null> {
  const [rows] = await conn.query<RowDataPacket[]>(`SELECT users.*, ${authorizationSql("users")} FROM users WHERE id = ? FOR UPDATE`, [id]);
  return (rows[0] as UserRow | undefined) ?? null;
}

export async function authorizeAccountWrite(conn: PoolConnection, target: UserRow | null, options?: AccountWrite, roles?: RoleRow[]): Promise<void> {
  if (!options?.authorize) return;
  const actorId = options.audit?.actorType === "user" ? options.audit.actorId : null;
  let actor: UserRow | null = null;
  if (actorId) {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT u.*, ${authorizationSql("u")} FROM users u LEFT JOIN org_units o ON o.id = u.org_unit_id
      WHERE u.id = ? AND u.status = 'active' AND (u.org_unit_id IS NULL OR (o.id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM org_units a WHERE (a.path = o.path OR LEFT(o.path, CHAR_LENGTH(CONCAT(TRIM(TRAILING '/' FROM a.path), '/'))) = CONCAT(TRIM(TRAILING '/' FROM a.path), '/')) AND a.status <> 'active'))) FOR UPDATE`, [actorId]);
    actor = (rows[0] as UserRow | undefined) ?? null;
    if (!actor) throw errors.unauthorized();
  }
  await options.authorize(target, actor, roles, conn);
}

export async function assertLoginIdentifiersFree(conn: PoolConnection, username: string, email: string, exceptId: string): Promise<void> {
  const [reserved] = await conn.query<RowDataPacket[]>("SELECT (? COLLATE utf8mb4_0900_ai_ci LIKE '!_!_deleted!_!_%' ESCAPE '!') OR (? COLLATE utf8mb4_0900_ai_ci LIKE '%@deleted.forge.invalid') AS reserved", [username, email]);
  if (Number(reserved[0]?.reserved)) throw errors.invalid("登录名或邮箱不可用");
  const [rows] = await conn.query<RowDataPacket[]>("SELECT id FROM users WHERE status <> 'deleted' AND id <> ? AND (username IN (?, ?) OR email IN (?, ?)) LIMIT 1 FOR UPDATE", [exceptId, username, email, username, email]);
  if (rows.length) throw errors.conflict("登录名或邮箱已被占用");
}

export async function deletionIdentifiers(conn: PoolConnection, id: string): Promise<{ username: string; email: string }> {
  // Old installations may already occupy a reserved spelling under the database's accent-insensitive collation.
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = attempt === 0 ? id : randomUUID().replaceAll("-", "");
    const username = `__deleted__${suffix}`, email = `${suffix}@deleted.forge.invalid`;
    const [rows] = await conn.query<RowDataPacket[]>("SELECT id FROM users WHERE id <> ? AND (username = ? OR email = ?) LIMIT 1 FOR UPDATE", [id, username, email]);
    if (!rows.length) return { username, email };
  }
  throw errors.conflict("无法释放登录标识，请刷新后重试");
}

export async function assertActivePlatformAdmin(conn: PoolConnection): Promise<void> {
  const [mappings] = await conn.query<RowDataPacket[]>("SELECT local_role FROM oidc_role_mappings");
  const [roles] = await conn.query<RowDataPacket[]>("SELECT `key` FROM roles WHERE status='active'");
  const mapped = !config.SSO_ROLE_MAPPING_REQUIRED || mappings.some(row => roles.some(role => role.key === row.local_role));
  const [rows] = await conn.query<RowDataPacket[]>(`SELECT u.id, u.password_hash, u.idp_subject, u.idp_issuer FROM users u LEFT JOIN org_units o ON o.id = u.org_unit_id
    WHERE u.role = 'platform_admin' AND u.status = 'active' AND (u.org_unit_id IS NULL OR (o.id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM org_units a WHERE (a.path = o.path OR LEFT(o.path, CHAR_LENGTH(CONCAT(TRIM(TRAILING '/' FROM a.path), '/'))) = CONCAT(TRIM(TRAILING '/' FROM a.path), '/')) AND a.status <> 'active'))) FOR UPDATE`);
  const available = rows.some(row => (config.ALLOW_LOCAL_LOGIN && isPasswordHash(row.password_hash)) || (mapped && config.SSO_MODE !== "disabled" && config.OIDC_ISSUER && config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET && row.idp_subject && row.idp_issuer === config.OIDC_ISSUER));
  if (!available) throw errors.conflict("至少保留一个可登录的平台管理员");
}

export function accountSnapshot(user: UserRow) {
  return { username: user.username, email: user.email, displayName: user.display_name, role: user.role, roles: user.authorization_json, dataScope: user.data_scope, orgUnitId: user.org_unit_id, status: user.status };
}
