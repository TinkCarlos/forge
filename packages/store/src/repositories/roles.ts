import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { BUILTIN_ROLES, errors, ForgeError, PERMISSION_CATALOG, ROLE_PERMISSIONS, ulidWithPrefix, type BuiltinRole } from "@forge/core";
import { one, query, transaction } from "../db.js";
import { assertActivePlatformAdmin, authorizeAccountWrite, lockAccounts, type AccountWrite } from "../account-write.js";
import { updateConfiguration } from "../configuration-revision.js";
import { auditRepo } from "./audit.js";
import type { RoleRow, UserRow } from "../types.js";

const selection = "r.*, (SELECT COALESCE(JSON_ARRAYAGG(rp.permission_key),JSON_ARRAY()) FROM role_permissions rp WHERE rp.role_id=r.id) AS permissions_json";
export interface RoleWrite extends Omit<AccountWrite, "authorize"> {
  authorize?: (target: RoleRow | null, actor: UserRow | null) => Promise<void>;
}
export interface RoleInput { key: string; name: string; description?: string; permissions: string[]; status?: string }

function validate(input: Partial<RoleInput>): void {
  if (input.key !== undefined && !/^[a-z][a-z0-9_]{0,31}$/.test(input.key)) throw errors.invalid("角色代码格式无效", { field: "key" });
  if (input.name !== undefined && (!input.name.trim() || Array.from(input.name.trim()).length > 128 || /[\u0000-\u001f\u007f]/u.test(input.name))) throw errors.invalid("请输入有效角色名称", { field: "name" });
  if (input.description !== undefined && (Array.from(input.description).length > 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.description))) throw errors.invalid("角色说明格式无效", { field: "description" });
  if (input.status !== undefined && !["active", "disabled"].includes(input.status)) throw errors.invalid("角色状态无效", { field: "status" });
  const catalog = new Set(PERMISSION_CATALOG.map(p => p.key));
  if (input.permissions && (new Set(input.permissions).size !== input.permissions.length || input.permissions.some(code => !catalog.has(code)))) throw errors.invalid("包含重复或不支持的权限", { field: "permissions" });
}
async function readRole(conn: PoolConnection, id: string): Promise<RoleRow | null> {
  const [rows] = await conn.query<RowDataPacket[]>(`SELECT ${selection} FROM roles r WHERE r.id=? AND r.status<>'deleted' FOR UPDATE`, [id]);
  return (rows[0] as RoleRow | undefined) ?? null;
}
async function authorize(conn: PoolConnection, target: RoleRow | null, options: RoleWrite): Promise<void> {
  await authorizeAccountWrite(conn, null, { ...options, authorize: (_target, actor) => options.authorize?.(target, actor) ?? Promise.resolve() });
}
async function writePermissions(conn: PoolConnection, id: string, permissions: string[]): Promise<void> {
  await conn.execute("DELETE FROM role_permissions WHERE role_id=?", [id]);
  for (const permission of permissions) await conn.execute("INSERT INTO role_permissions (role_id,permission_key) VALUES (?,?)", [id, permission]);
}
async function references(conn: Pick<PoolConnection, "query">, role: RoleRow): Promise<Record<string, number>> {
  const [rows] = await conn.query<RowDataPacket[]>(`SELECT
    (SELECT COUNT(*) FROM users WHERE role=? AND status<>'deleted') AS users,
    (SELECT COUNT(*) FROM service_accounts WHERE role=?) AS serviceAccounts,
    (SELECT COUNT(*) FROM role_bindings WHERE role_id=?) AS bindings,
    (SELECT COUNT(*) FROM oidc_role_mappings WHERE local_role=?) AS ssoMappings,
    (SELECT COUNT(*) FROM data_policies WHERE role=?) AS dataPolicies`, [role.key, role.key, role.id, role.key, role.key]);
  return Object.fromEntries(Object.entries(rows[0]!).map(([key,value]) => [key,Number(value)]));
}

export const rolesRepo = {
  async listRoles(): Promise<RoleRow[]> { return query<RoleRow>(`SELECT ${selection} FROM roles r WHERE r.status<>'deleted' ORDER BY r.builtin DESC,r.key`); },
  async getRole(id: string): Promise<RoleRow | null> { return one<RoleRow>(`SELECT ${selection} FROM roles r WHERE r.id=? AND r.status<>'deleted'`, [id]); },
  async getRoleByKey(key: string): Promise<RoleRow | null> { return one<RoleRow>(`SELECT ${selection} FROM roles r WHERE r.key=? AND r.status<>'deleted'`, [key]); },
  async roleReferences(role: RoleRow) { return transaction(conn => references(conn,role)); },
  async createRole(input: RoleInput, options: RoleWrite, source?: { id: string; revision: number }): Promise<string> {
    return transaction(async conn => {
      await lockAccounts(conn);
      const original = source ? await readRole(conn, source.id) : null;
      if (source && !original) throw errors.notFound("角色不存在");
      if (source && original!.revision !== source.revision) throw errors.conflict("角色已变更，请重新打开后复制");
      const permissions = original ? original.permissions_json.includes("*") ? PERMISSION_CATALOG.map(p => p.key) : original.permissions_json : input.permissions;
      validate({ ...input, permissions });
      await authorize(conn, original, options);
      const [existing] = await conn.query<RowDataPacket[]>("SELECT id FROM roles WHERE `key`=?", [input.key]);
      if (existing.length) throw errors.conflict("角色代码已存在");
      const id = ulidWithPrefix("rol");
      await conn.execute("INSERT INTO roles (id,`key`,name,description,status) VALUES (?,?,?,?,?)", [id,input.key,input.name.trim(),input.description ?? original?.description ?? "",input.status ?? "active"]);
      await writePermissions(conn, id, permissions);
      if (options.audit) await auditRepo.audit({ ...options.audit, resourceId:id, details:{ after:{ ...input, permissions }, ...(source ? { copiedFrom:source.id } : {}) } },conn);
      return id;
    });
  },
  async updateRole(id: string, input: Partial<Omit<RoleInput, "key">>, options: RoleWrite, action?: "delete" | "reset"): Promise<number> {
    return transaction(async conn => {
      await lockAccounts(conn);
      const role = await readRole(conn,id);
      if (!role) throw errors.notFound("角色不存在");
      await authorize(conn,role,options);
      if (role.key === "platform_admin") throw errors.forbidden("平台管理员角色不可修改");
      if (action === "delete") {
        if (Number(role.builtin)) throw errors.conflict("内置角色不可删除");
        if (Object.values(await references(conn,role)).some(Number)) throw errors.conflict("角色仍被引用，请先解除关联");
      }
      if (action === "reset" && !(BUILTIN_ROLES as readonly string[]).includes(role.key)) throw errors.invalid("只有内置角色可恢复模板");
      const fields = action === "reset" ? { permissions: ROLE_PERMISSIONS[role.key as BuiltinRole] } : input;
      validate(fields);
      const revision = await updateConfiguration("roles",id,{ name:fields.name?.trim() ?? role.name, description:fields.description, status:action === "delete" ? "deleted" : fields.status },{
        ...options,connection:conn,audit:undefined,afterWrite:async () => { if(fields.permissions) await writePermissions(conn,id,fields.permissions); await assertActivePlatformAdmin(conn); },
      });
      if (options.audit) await auditRepo.audit({ ...options.audit, details:{ before:role, after:await readRole(conn,id), ...(action ? { action } : {}) } },conn);
      return revision;
    });
  },
};

/** Called only while holding identity.account-lock. Disabled existing assignments can be retained, never newly granted. */
export async function assignedRoles(conn: PoolConnection, type: "user" | "service_account", id: string, primary: string, additionalIds: string[] | undefined, previousPrimary?: string): Promise<RoleRow[]> {
  const [old] = await conn.query<RowDataPacket[]>("SELECT role_id FROM role_bindings WHERE principal_type=? AND principal_id=? AND scope_type='global' AND scope_id=''", [type,id]);
  const existing = new Set(old.map(row => String(row.role_id)));
  const [rows] = await conn.query<RowDataPacket[]>(`SELECT ${selection} FROM roles r WHERE r.key=? OR r.id IN (${[...(additionalIds ?? existing)].map(() => "?").join(",") || "NULL"})`, [primary,...(additionalIds ?? existing)]);
  const roles = rows as RoleRow[];
  const main = roles.find(role => role.key === primary);
  if (!main || main.status === "deleted" || (main.status !== "active" && previousPrimary !== primary)) throw errors.invalid("主角色不存在或已停用",{field:"role"});
  const ids = additionalIds ?? [...existing].filter(roleId => roleId !== main.id);
  if (ids.length > 32 || new Set(ids).size !== ids.length || ids.includes(main.id)) throw errors.invalid("附加角色重复、过多或与主角色相同",{field:"additionalRoleIds"});
  for (const roleId of ids) {
    const role = roles.find(row => row.id === roleId);
    if (!role || role.status === "deleted" || (role.status !== "active" && !existing.has(roleId)) || role.key === "platform_admin") throw errors.invalid("附加角色不存在、已停用或不可分配",{field:"additionalRoleIds"});
  }
  if (type === "service_account" && primary === "platform_admin") throw new ForgeError("SCD-4804",{message:"服务账号不能使用平台管理员角色",httpStatus:400,details:{field:"role"}});
  return [main,...ids.map(roleId => roles.find(role => role.id === roleId)!)];
}
export async function replaceRoleBindings(conn: PoolConnection,type:"user"|"service_account",id:string,roles:RoleRow[]):Promise<void> {
  await conn.execute("DELETE FROM role_bindings WHERE principal_type=? AND principal_id=? AND scope_type='global' AND scope_id=''",[type,id]);
  for(const role of roles.slice(1)) await conn.execute("INSERT INTO role_bindings (id,role_id,principal_type,principal_id) VALUES (?,?,?,?)",[ulidWithPrefix("rbd"),role.id,type,id]);
}
