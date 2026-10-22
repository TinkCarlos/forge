import { ulidWithPrefix } from "@forge/core";
import { execute, one, query } from "../db.js";
import type { UserRow } from "../types.js";

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
  async listUsers(): Promise<UserRow[]> {
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
  }): Promise<string> {
    const id = ulidWithPrefix("usr");
    await execute(
      `INSERT INTO users (id, username, email, display_name, password_hash, role, data_scope, org_unit_id, idp_subject, is_emergency_admin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const rows = await query<{ id: string }>("SELECT id FROM org_units WHERE path LIKE ?", [`${path}%`]);
    return rows.map((row) => row.id);
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
};
