import { ulidWithPrefix } from "@forge/core";
import { execute, one, query, transaction } from "../db.js";
import type { ServiceAccountRow, UserFilter, UserRow } from "../types.js";

/** Escapes a literal for LIKE ... ESCAPE '!' ("!" rather than "\\" so the SQL does not depend on NO_BACKSLASH_ESCAPES). */
export function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (ch) => `!${ch}`);
}

/**
 * SQL: org unit `a` is `o` itself or one of its ancestors (AB). Literal prefix compare (no LIKE) and the prefix always
 * ends with "/", so "/x/b" is not an ancestor of "/x/bc"; the root "/" stays an ancestor of everything.
 */
const ANCESTOR_OF_O = "(a.path = o.path OR LEFT(o.path, CHAR_LENGTH(CONCAT(TRIM(TRAILING '/' FROM a.path), '/'))) = CONCAT(TRIM(TRAILING '/' FROM a.path), '/'))";

export const identityRepo = {
  // Users / orgs
  async getUserByEmail(email: string): Promise<UserRow | null> {
    return one<UserRow>("SELECT * FROM users WHERE email = ? AND status = 'active'", [email]);
  },
  async getUserById(id: string): Promise<UserRow | null> {
    return one<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  },
  async getUserByIdpSubject(subject: string): Promise<UserRow | null> {
    return one<UserRow>("SELECT * FROM users WHERE idp_subject = ?", [subject]);
  },
  /** Users visible through `filter` (scope applied in SQL): `{}` -> all; `orgIds` -> those departments ([] -> none); `userId` -> only that user. */
  async listUsers(filter: UserFilter = {}): Promise<UserRow[]> {
    if (filter.userId !== undefined) return query<UserRow>("SELECT * FROM users WHERE id = ? ORDER BY created_at DESC", [filter.userId]);
    if (filter.orgIds) {
      if (!filter.orgIds.length) return [];
      return query<UserRow>(`SELECT * FROM users WHERE org_unit_id IN (${filter.orgIds.map(() => "?").join(", ")}) ORDER BY created_at DESC`, filter.orgIds);
    }
    return query<UserRow>("SELECT * FROM users ORDER BY created_at DESC");
  },
  async createUser(input: {
    email: string;
    username: string;
    displayName: string;
    role?: string;
    dataScope?: string;
    orgUnitId?: string | null;
    passwordHash?: string | null;
    idpSubject?: string | null;
    emergency?: boolean;
    status?: string;
  }): Promise<string> {
    const id = ulidWithPrefix("usr");
    await execute(
      `INSERT INTO users (id, username, email, display_name, password_hash, role, data_scope, org_unit_id, idp_subject, is_emergency_admin, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.username,
        input.email,
        input.displayName,
        input.passwordHash ?? null,
        input.role ?? "user",
        input.dataScope ?? "self",
        input.orgUnitId ?? null,
        input.idpSubject ?? null,
        input.emergency ? 1 : 0,
        input.status ?? "active",
      ],
    );
    return id;
  },
  async updateUser(id: string, fields: { role?: string; status?: string; orgUnitId?: string | null; dataScope?: string; displayName?: string }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.role) { sets.push("role = ?"); params.push(fields.role); }
    if (fields.status) { sets.push("status = ?"); params.push(fields.status); }
    if (fields.orgUnitId !== undefined) { sets.push("org_unit_id = ?"); params.push(fields.orgUnitId); }
    if (fields.dataScope) { sets.push("data_scope = ?"); params.push(fields.dataScope); }
    if (fields.displayName) { sets.push("display_name = ?"); params.push(fields.displayName); }
    if (!sets.length) return;
    params.push(id);
    if (fields.status && fields.status !== "active") {
      // Session store (007): a user who is no longer active is logged out everywhere at once. The status change and the
      // session delete commit together, so a failed delete leaves the user active with the sessions intact.
      await transaction(async (conn) => {
        await conn.execute(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params as never[]);
        await conn.execute("DELETE FROM auth_sessions WHERE user_id = ?", [id]);
      });
      return;
    }
    await execute(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async getOrgUnit(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM org_units WHERE id = ?", [id]);
  },
  async listOrgUnits(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM org_units ORDER BY path, name");
  },
  async orgSubtreeIds(orgId: string | null): Promise<string[]> {
    if (!orgId) return [];
    const org = await identityRepo.getOrgUnit(orgId);
    if (!org) return [];
    const path = String(org.path ?? "");
    if (!path) return [String(org.id)];
    // AB / I-SCOPE-11: the path is matched literally. LIKE wildcards in it are escaped and the descendant pattern always
    // ends with the separator, so "/x/a_b/" never matches "/x/axb/" and "/x/b" never matches "/x/bc".
    const base = path.endsWith("/") ? path : `${path}/`;
    const rows = await query<{ id: string }>("SELECT id FROM org_units WHERE path = ? OR path LIKE ? ESCAPE '!'", [path, `${escapeLike(base)}%`]);
    return rows.map((row) => row.id);
  },

  /**
   * One query: the user row when the user exists, is active, and either has no department or its department exists and
   * neither it nor any ancestor (path prefix, the department itself included) has a status other than active. Else null.
   */
  async getActiveUserById(id: string): Promise<UserRow | null> {
    if (!id) return null;
    return one<UserRow>(
      `SELECT u.* FROM users u LEFT JOIN org_units o ON o.id = u.org_unit_id
       WHERE u.id = ? AND u.status = 'active'
         AND (u.org_unit_id IS NULL OR (o.id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM org_units a WHERE ${ANCESTOR_OF_O} AND a.status <> 'active')))`,
      [id],
    );
  },

  // SSO role mappings / credentials
  async listRoleMappings(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM oidc_role_mappings ORDER BY agent_role_code");
  },
  async upsertRoleMapping(agentCode: string, agentName: string, localRole: string): Promise<void> {
    await execute(
      "INSERT INTO oidc_role_mappings (id, agent_role_code, agent_role_name, local_role) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE local_role = VALUES(local_role)",
      [ulidWithPrefix("orm"), agentCode, agentName, localRole],
    );
  },
  async deleteRoleMapping(id: string): Promise<void> {
    await execute("DELETE FROM oidc_role_mappings WHERE id = ?", [id]);
  },
  async updateUserPassword(id: string, passwordHash: string): Promise<void> {
    await execute("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, id]);
  },
  async setIdpSubject(id: string, subject: string): Promise<void> {
    await execute("UPDATE users SET idp_subject = ? WHERE id = ?", [subject, id]);
  },
  // Service accounts (machine identities for schedules/integrations; cannot log in)
  async listServiceAccounts(): Promise<ServiceAccountRow[]> {
    return query<ServiceAccountRow>("SELECT * FROM service_accounts ORDER BY created_at DESC");
  },
  async getServiceAccount(id: string): Promise<ServiceAccountRow | null> {
    return one<ServiceAccountRow>("SELECT * FROM service_accounts WHERE id = ?", [id]);
  },
  /**
   * Service account by id only if it is active AND its department chain is usable (same rule as getActiveUserById:
   * no department, or the department exists and neither it nor any ancestor is inactive). Else null. One query.
   */
  async getActiveServiceAccountById(id: string): Promise<ServiceAccountRow | null> {
    if (!id) return null;
    return one<ServiceAccountRow>(
      `SELECT s.* FROM service_accounts s LEFT JOIN org_units o ON o.id = s.org_unit_id
       WHERE s.id = ? AND s.status = 'active'
         AND (s.org_unit_id IS NULL OR (o.id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM org_units a WHERE ${ANCESTOR_OF_O} AND a.status <> 'active')))`,
      [id],
    );
  },
  async getServiceAccountByKey(key: string): Promise<ServiceAccountRow | null> {
    return one<ServiceAccountRow>("SELECT * FROM service_accounts WHERE `key` = ?", [key]);
  },
  async createServiceAccount(input: { key: string; name: string; description?: string; orgUnitId?: string | null; role?: string; dataScope?: string; createdBy?: string | null }): Promise<string> {
    const id = ulidWithPrefix("svc");
    await execute(
      "INSERT INTO service_accounts (id, `key`, name, description, org_unit_id, role, data_scope, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, input.key, input.name, input.description ?? "", input.orgUnitId ?? null, input.role ?? "user", input.dataScope ?? "org", input.createdBy ?? null],
    );
    return id;
  },
  async updateServiceAccount(id: string, fields: { name?: string; description?: string; role?: string; dataScope?: string; status?: string }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.name) { sets.push("name = ?"); params.push(fields.name); }
    if (fields.description !== undefined) { sets.push("description = ?"); params.push(fields.description); }
    if (fields.role) { sets.push("role = ?"); params.push(fields.role); }
    if (fields.dataScope) { sets.push("data_scope = ?"); params.push(fields.dataScope); }
    if (fields.status) { sets.push("status = ?"); params.push(fields.status); }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE service_accounts SET ${sets.join(", ")} WHERE id = ?`, params);
  },
};
