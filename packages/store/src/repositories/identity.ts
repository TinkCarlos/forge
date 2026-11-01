import { assignedRoles, replaceRoleBindings } from "./roles.js";
import { ssoRoleSnapshot } from "../sso-role-snapshot.js";
import { authorizationSql } from "../authorization-sql.js";
import { updateConfiguration } from "../configuration-revision.js";
import { accountText, errors, ForgeError, ulidWithPrefix } from "@forge/core";
import type { RowDataPacket } from "mysql2/promise";
import { accountSnapshot, assertActivePlatformAdmin, assertLoginIdentifiersFree, authorizeAccountWrite, deletionIdentifiers, lockedUser, lockAccounts, type AccountWrite } from "../account-write.js";
import { auditRepo } from "./audit.js";
import { userUpdateAuditEntries } from "./audit-scope-sql.js";
import type { UserListQuery } from "@forge/contracts";
import { pageResult, readPageCursor } from "../pagination.js";
import { execute, one, query, transaction, type ReadConnection } from "../db.js";
import type { RoleRow, ServiceAccountRow, UserFilter, UserRow } from "../types.js";

/** Escapes a literal for LIKE ... ESCAPE '!' ("!" rather than "\\" so the SQL does not depend on NO_BACKSLASH_ESCAPES). */
export function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (ch) => `!${ch}`);
}

/**
 * SQL: org unit `a` is `o` itself or one of its ancestors (AB). Literal prefix compare (no LIKE) and the prefix always
 * ends with "/", so "/x/b" is not an ancestor of "/x/bc"; the root "/" stays an ancestor of everything.
 */
const ANCESTOR_OF_O = "(a.path = o.path OR LEFT(o.path, CHAR_LENGTH(CONCAT(TRIM(TRAILING '/' FROM a.path), '/'))) = CONCAT(TRIM(TRAILING '/' FROM a.path), '/'))";

export interface ServiceAccountWrite extends Omit<AccountWrite,"authorize"> { authorize?:(target:ServiceAccountRow|null,actor:UserRow|null,roles:RoleRow[],connection:ReadConnection)=>Promise<void> }

export const identityRepo = {
  getSsoRoleSnapshot:ssoRoleSnapshot,
  async bootstrapAdmin(input: { id: string; email: string; name: string; passwordHash: string; orgUnitId: string }): Promise<{ id: string; created: boolean }> {
    return transaction(async conn => {
      await lockAccounts(conn);
      const existing = await lockedUser(conn, input.id);
      if (existing) return { id: existing.id, created: false };
      const email = accountText(input.email, "email"), name = accountText(input.name, "displayName");
      await assertLoginIdentifiersFree(conn, "admin", email, input.id);
      await conn.execute("INSERT INTO users (id, username, email, display_name, password_hash, role, data_scope, org_unit_id, is_emergency_admin) VALUES (?, 'admin', ?, ?, ?, 'platform_admin', 'all', ?, 1)", [input.id, email, name, input.passwordHash, input.orgUnitId]);
      await auditRepo.audit({ actorType: "system", action: "user.bootstrap", resourceType: "user", resourceId: input.id, orgUnitId: input.orgUnitId, details: { created: true } }, conn);
      return { id: input.id, created: true };
    });
  },
  // Users / orgs
  async getUserByEmail(email: string): Promise<UserRow | null> {
    return one<UserRow>(`SELECT users.*, ${authorizationSql("users")} FROM users WHERE email = ? AND status = 'active'`, [email]);
  },
  async getUserById(id: string): Promise<UserRow | null> {
    return one<UserRow>(`SELECT users.*, ${authorizationSql("users")} FROM users WHERE id = ?`, [id]);
  },
  async getUserByIdpSubject(subject: string, issuer?: string): Promise<UserRow | null> {
    return issuer === undefined ? one<UserRow>(`SELECT users.*, ${authorizationSql("users")} FROM users WHERE idp_subject = ?`, [subject]) : one<UserRow>(`SELECT users.*, ${authorizationSql("users")} FROM users WHERE idp_subject = ? AND idp_issuer = ?`, [subject, issuer]);
  },
  async getUserByLogin(identifier: string): Promise<UserRow | null> {
    const rows = await query<UserRow>(`SELECT users.*, ${authorizationSql("users")} FROM users WHERE status <> 'deleted' AND (email = ? OR username = ?) LIMIT 2`, [identifier.trim(), identifier.trim()]);
    return rows.length === 1 && rows[0]!.status === "active" ? rows[0]! : null;
  },
  /** Users visible through `filter` (scope applied in SQL): `{}` -> all; `orgIds` -> those departments ([] -> none); `userId` -> only that user. */
  async listUsers(filter: UserFilter = {}): Promise<UserRow[]> {
    if (filter.userId !== undefined) return query<UserRow>(`SELECT users.*, ${authorizationSql("users")} FROM users WHERE status <> 'deleted' AND id = ? ORDER BY created_at DESC`, [filter.userId]);
    if (filter.orgIds) {
      if (!filter.orgIds.length) return [];
      return query<UserRow>(`SELECT users.*, ${authorizationSql("users")} FROM users WHERE status <> 'deleted' AND org_unit_id IN (${filter.orgIds.map(() => "?").join(", ")}) ORDER BY created_at DESC`, filter.orgIds);
    }
    return query<UserRow>(`SELECT users.*, ${authorizationSql("users")} FROM users WHERE status <> 'deleted' ORDER BY created_at DESC`);
  },
  async listUsersPage(filter: UserFilter, input: UserListQuery) {
    const where = ["status <> 'deleted'"];
    const params: unknown[] = [];
    if (filter.userId !== undefined) { where.push("id = ?"); params.push(filter.userId); }
    if (filter.orgIds) {
      if (!filter.orgIds.length) return { items: [], nextCursor: null };
      where.push(`org_unit_id IN (${filter.orgIds.map(() => "?").join(",")})`); params.push(...filter.orgIds);
    }
    if (input.status) { where.push("status = ?"); params.push(input.status); }
    if (input.q?.trim()) { where.push("(username LIKE ? ESCAPE '!' OR email LIKE ? ESCAPE '!' OR display_name LIKE ? ESCAPE '!')"); params.push(...Array(3).fill(`%${escapeLike(input.q.trim())}%`)); }
    const cursor = readPageCursor(input.cursor);
    if (cursor) { where.push("(created_at < ? OR (created_at = ? AND id < ?))"); params.push(new Date(cursor.createdAt), new Date(cursor.createdAt), cursor.id); }
    const limit = input.limit ?? 50;
    const rows = await query<UserRow>(`SELECT users.*, ${authorizationSql("users")} FROM users WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`, [...params, limit + 1]);
    return pageResult(rows, limit);
  },
  async createUser(input: {
    email: string;
    username: string;
    displayName: string;
    role?: string;
    additionalRoleIds?: string[];
    dataScope?: string;
    orgUnitId?: string | null;
    passwordHash?: string | null;
    idpSubject?: string | null;
    idpIssuer?: string | null;
    emergency?: boolean;
    status?: string;
  }, options?: AccountWrite): Promise<string> {
    const id = ulidWithPrefix("usr");
    const username = accountText(input.username, "username");
    const email = accountText(input.email, "email");
    const displayName = accountText(input.displayName, "displayName");
    await transaction(async conn => {
      await lockAccounts(conn);
      if(options?.roleMappingRevision && options.roleMappingRevision!==(await ssoRoleSnapshot(conn)).revision) throw new ForgeError("SSO-1201",{message:"SSO角色授权已变更，请重新登录"});
      const roles = await assignedRoles(conn,"user",id,input.role ?? "user",input.additionalRoleIds);
      await authorizeAccountWrite(conn, null, options, roles);
      await assertLoginIdentifiersFree(conn, username, email, id);
      await conn.execute(
      `INSERT INTO users (id, username, email, display_name, password_hash, role, data_scope, org_unit_id, idp_subject, idp_issuer, is_emergency_admin, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        username,
        email,
        displayName,
        input.passwordHash ?? null,
        input.role ?? "user",
        input.dataScope ?? "self",
        input.orgUnitId ?? null,
        input.idpSubject ?? null,
        input.idpIssuer ?? null,
        input.emergency ? 1 : 0,
        input.status ?? "active",
      ],
      );
      await replaceRoleBindings(conn,"user",id,roles);
      if (options?.audit) await auditRepo.audit({ ...options.audit, resourceId: id, orgUnitId: input.orgUnitId ?? null, details: { ...(options.audit.details as object), after: { username, email, displayName, additionalRoleIds:roles.slice(1).map(role=>role.id), role: input.role ?? "user", dataScope: input.dataScope ?? "self", orgUnitId: input.orgUnitId ?? null, status: input.status ?? "active" } } }, conn);
    });
    return id;
  },
  async updateUser(id: string, fields: { username?: string; email?: string; role?: string; status?: string; orgUnitId?: string | null; dataScope?: string; displayName?: string; passwordHash?: string | null; revokeSessions?: boolean; additionalRoleIds?: string[] }, options: AccountWrite): Promise<number> {
    return transaction(async conn => {
      await lockAccounts(conn);
      const target = await lockedUser(conn, id);
      if (!target || target.status === "deleted") throw errors.notFound("用户不存在");
      const roles = await assignedRoles(conn,"user",id,fields.role ?? target.role,fields.additionalRoleIds,target.role);
      await authorizeAccountWrite(conn, target, options, roles);
      const username = fields.username === undefined ? target.username : accountText(fields.username, "username");
      const email = fields.email === undefined ? target.email : accountText(fields.email, "email");
      const values: Record<string, unknown> = {
        ...(fields.username !== undefined ? { username } : {}), ...(fields.email !== undefined ? { email } : {}),
        ...(fields.role ? { role: fields.role } : {}), ...(fields.status ? { status: fields.status } : {}),
        ...(fields.orgUnitId !== undefined ? { org_unit_id: fields.orgUnitId } : {}), ...(fields.dataScope ? { data_scope: fields.dataScope } : {}),
        ...(fields.displayName !== undefined ? { display_name: accountText(fields.displayName, "displayName") } : {}),
        ...(fields.passwordHash !== undefined ? { password_hash: fields.passwordHash } : {}),
      };
      if (fields.status === "deleted") Object.assign(values, await deletionIdentifiers(conn, id), { password_hash: null });
      else await assertLoginIdentifiersFree(conn, username, email, id);
      // Even a session-only revocation advances the version, invalidating a concurrent login verification.
      if ((fields.revokeSessions || fields.additionalRoleIds !== undefined) && !Object.keys(values).length) values.status = target.status;
      const revision = await updateConfiguration("users", id, values, { ...options, connection: conn, audit: undefined, afterWrite: async () => {
        if (fields.status === "deleted") await conn.execute("DELETE FROM role_bindings WHERE principal_type='user' AND principal_id=?",[id]);
        else await replaceRoleBindings(conn,"user",id,roles);
        if (target.role === "platform_admin") await assertActivePlatformAdmin(conn);
        if ((fields.status && fields.status !== "active") || fields.passwordHash !== undefined || fields.revokeSessions) await conn.execute("DELETE FROM auth_sessions WHERE user_id = ?", [id]);
        if (options.afterWrite) await options.afterWrite(conn);
      } });
      if (options.audit) {
        const after = (await lockedUser(conn, id))!;
        const details = { ...(options.audit.details as object), before: accountSnapshot(target), after: accountSnapshot(after), ...(fields.passwordHash !== undefined ? { passwordChanged: true } : {}) };
        const entries = options.audit.action === "user.update" ? userUpdateAuditEntries(target.org_unit_id, after.org_unit_id, details) : [{ action: options.audit.action, orgUnitId: target.org_unit_id, details }];
        for (const entry of entries) await auditRepo.audit({ ...options.audit, ...entry }, conn);
      }
      return revision;
    });
  },
  async bindUserIdentity(id: string, subject: string | null, issuer: string | null, options: AccountWrite): Promise<number> {
    return transaction(async conn => {
      await lockAccounts(conn);
      const target = await lockedUser(conn, id);
      if (!target || target.status === "deleted") throw errors.notFound("用户不存在");
      await authorizeAccountWrite(conn, target, options);
      // CAS precedes releasing a deleted identity: a stale form must have no side effects.
      if (options.expectedRevision !== "system" && target.revision !== options.expectedRevision) throw errors.conflict("配置已被修改，请重新打开并比较后保存");
      if (subject) {
        const [rows] = await conn.query<RowDataPacket[]>(`SELECT users.*, ${authorizationSql("users")} FROM users WHERE idp_subject = ? FOR UPDATE`, [subject]);
        const owner = rows[0] as UserRow | undefined;
        if (owner && owner.id !== id) {
          if (owner.status !== "deleted") throw errors.conflict("SSO身份已绑定其他账号");
          await conn.execute("UPDATE users SET idp_subject = NULL, idp_issuer = NULL, revision = revision + 1 WHERE id = ?", [owner.id]);
          if (options.audit) await auditRepo.audit({ ...options.audit, action: "user.sso.unbind", resourceId: owner.id, orgUnitId: null, details: { subject, reassignedTo: id } }, conn);
        }
      }
      const revision = await updateConfiguration("users", id, { idp_subject: subject, idp_issuer: issuer }, { ...options, connection: conn, audit: undefined });
      if (target.role === "platform_admin") await assertActivePlatformAdmin(conn);
      await conn.execute("DELETE FROM auth_sessions WHERE user_id = ?", [id]);
      if (options.audit) await auditRepo.audit({ ...options.audit, orgUnitId: null, details: { beforeSubject: target.idp_subject, afterSubject: subject, beforeIssuer: target.idp_issuer ?? null, afterIssuer: issuer } }, conn);
      return revision;
    });
  },
  async getOrgUnit(id: string, connection?: ReadConnection): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM org_units WHERE id = ?", [id], connection);
  },
  async getActiveOrgUnit(id: string, connection?: ReadConnection): Promise<Record<string, unknown> | null> {
    return one(`SELECT o.* FROM org_units o WHERE o.id = ? AND NOT EXISTS (SELECT 1 FROM org_units a WHERE ${ANCESTOR_OF_O} AND a.status <> 'active')`, [id], connection);
  },
  async listOrgUnits(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM org_units ORDER BY path, name");
  },
  async orgSubtreeIds(orgId: string | null, connection?: ReadConnection): Promise<string[]> {
    if (!orgId) return [];
    const org = await identityRepo.getOrgUnit(orgId, connection);
    if (!org) return [];
    const path = String(org.path ?? "");
    if (!path) return [String(org.id)];
    // AB / I-SCOPE-11: the path is matched literally. LIKE wildcards in it are escaped and the descendant pattern always
    // ends with the separator, so "/x/a_b/" never matches "/x/axb/" and "/x/b" never matches "/x/bc".
    const base = path.endsWith("/") ? path : `${path}/`;
    const rows = await query<{ id: string }>("SELECT id FROM org_units WHERE path = ? OR path LIKE ? ESCAPE '!'", [path, `${escapeLike(base)}%`], connection);
    return rows.map((row) => row.id);
  },

  /**
   * One query: the user row when the user exists, is active, and either has no department or its department exists and
   * neither it nor any ancestor (path prefix, the department itself included) has a status other than active. Else null.
   */
  async getActiveUserById(id: string, connection?: ReadConnection): Promise<UserRow | null> {
    if (!id) return null;
    return one<UserRow>(
      `SELECT u.*, ${authorizationSql("u")} FROM users u LEFT JOIN org_units o ON o.id = u.org_unit_id
       WHERE u.id = ? AND u.status = 'active'
         AND (u.org_unit_id IS NULL OR (o.id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM org_units a WHERE ${ANCESTOR_OF_O} AND a.status <> 'active')))`,
      [id], connection,
    );
  },

  // SSO role mappings / credentials
  async listRoleMappings(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM oidc_role_mappings ORDER BY agent_role_code");
  },
  async upsertRoleMapping(agentCode: string, agentName: string, localRole: string, options: AccountWrite & { createOnly?: boolean }): Promise<number> {
    return transaction(async (conn) => {
      await lockAccounts(conn);
      const roles=await assignedRoles(conn,"user","",localRole,[]);
      await authorizeAccountWrite(conn,null,options,roles);
      const [rows] = await conn.query("SELECT id FROM oidc_role_mappings WHERE agent_role_code = ?", [agentCode]);
      const existing = (rows as Array<{ id: string }>)[0];
      if (existing) {
        if (options.createOnly) throw errors.conflict("角色映射已存在，请重新打开后修改");
        return updateConfiguration("oidc_role_mappings", existing.id, { agent_role_name: agentName, local_role: localRole }, { ...options, connection: conn });
      }
      if (options.expectedRevision !== "system") throw new ForgeError("CFG-8503", { message: "角色映射已变化，请重新打开" });
      const id = ulidWithPrefix("orm");
      await conn.execute("INSERT INTO oidc_role_mappings (id, agent_role_code, agent_role_name, local_role) VALUES (?, ?, ?, ?)", [id, agentCode, agentName, localRole]);
      if (options.audit) {
        const { auditRepo } = await import("./audit.js");
        await auditRepo.audit({ ...options.audit, resourceId: id }, conn);
      }
      return 1;
    });
  },
  async deleteRoleMapping(id: string): Promise<void> {
    await execute("DELETE FROM oidc_role_mappings WHERE id = ?", [id]);
  },
  // Service accounts (machine identities for schedules/integrations; cannot log in)
  async listServiceAccounts(orgIds: string[] | null = null): Promise<ServiceAccountRow[]> {
    if(orgIds && !orgIds.length)return [];
    return query<ServiceAccountRow>(`SELECT service_accounts.*, ${authorizationSql("service_accounts", "service_account")} FROM service_accounts ${orgIds ? `WHERE org_unit_id IN (${orgIds.map(()=>"?").join(",")})` : ""} ORDER BY created_at DESC`,orgIds??[]);
  },
  async getServiceAccount(id: string): Promise<ServiceAccountRow | null> {
    return one<ServiceAccountRow>(`SELECT service_accounts.*, ${authorizationSql("service_accounts", "service_account")} FROM service_accounts WHERE id = ?`, [id]);
  },
  /**
   * Service account by id only if it is active AND its department chain is usable (same rule as getActiveUserById:
   * no department, or the department exists and neither it nor any ancestor is inactive). Else null. One query.
   */
  async getActiveServiceAccountById(id: string, connection?: ReadConnection): Promise<ServiceAccountRow | null> {
    if (!id) return null;
    return one<ServiceAccountRow>(
      `SELECT s.*, ${authorizationSql("s", "service_account")} FROM service_accounts s LEFT JOIN org_units o ON o.id = s.org_unit_id
       WHERE s.id = ? AND s.status = 'active'
         AND (s.org_unit_id IS NULL OR (o.id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM org_units a WHERE ${ANCESTOR_OF_O} AND a.status <> 'active')))`,
      [id], connection,
    );
  },
  async getServiceAccountByKey(key: string): Promise<ServiceAccountRow | null> {
    return one<ServiceAccountRow>(`SELECT service_accounts.*, ${authorizationSql("service_accounts", "service_account")} FROM service_accounts WHERE \`key\` = ?`, [key]);
  },
  async createServiceAccount(input: { key: string; name: string; description?: string; orgUnitId?: string | null; role?: string; additionalRoleIds?:string[]; dataScope?: string; createdBy?: string | null },options?:ServiceAccountWrite): Promise<string> {
    return transaction(async conn=>{
      await lockAccounts(conn);
      const id=ulidWithPrefix("svc");
      const roles=await assignedRoles(conn,"service_account",id,input.role??"user",input.additionalRoleIds);
      await authorizeAccountWrite(conn,null,{...options,expectedRevision:"system",authorize:(_target,actor)=>options?.authorize?.(null,actor,roles,conn)??Promise.resolve()});
      await conn.execute("INSERT INTO service_accounts (id, `key`, name, description, org_unit_id, role, data_scope, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id,input.key,input.name,input.description??"",input.orgUnitId??null,input.role??"user",input.dataScope??"org",input.createdBy??null]);
      await replaceRoleBindings(conn,"service_account",id,roles);
      if(options?.audit)await auditRepo.audit({...options.audit,resourceId:id,details:{after:{...input,additionalRoleIds:roles.slice(1).map(role=>role.id)}}},conn);
      return id;
    });
  },
  async updateServiceAccount(id:string,fields:{name?:string;description?:string;role?:string;additionalRoleIds?:string[];dataScope?:string;status?:string},options:ServiceAccountWrite):Promise<number>{
    return transaction(async conn=>{
      await lockAccounts(conn);
      const [rows]=await conn.query<RowDataPacket[]>(`SELECT service_accounts.*,${authorizationSql("service_accounts","service_account")} FROM service_accounts WHERE id=? FOR UPDATE`,[id]);
      const target=rows[0] as ServiceAccountRow|undefined;
      if(!target)throw errors.notFound("服务账号不存在");
      const roles=await assignedRoles(conn,"service_account",id,fields.role??target.role,fields.additionalRoleIds,target.role);
      await authorizeAccountWrite(conn,null,{...options,authorize:(_target,actor)=>options.authorize?.(target,actor,roles,conn)??Promise.resolve()});
      const values={name:fields.name??target.name,description:fields.description,role:fields.role,data_scope:fields.dataScope,status:fields.status};
      const revision=await updateConfiguration("service_accounts",id,values,{...options,connection:conn,audit:undefined,afterWrite:()=>replaceRoleBindings(conn,"service_account",id,roles)});
      if(options.audit)await auditRepo.audit({...options.audit,details:{before:{name:target.name,role:target.role,dataScope:target.data_scope,status:target.status,roles:target.authorization_json},changes:fields}},conn);
      return revision;
    });
  },
};
