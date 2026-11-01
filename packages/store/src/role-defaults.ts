import type { Connection, RowDataPacket } from "mysql2/promise";
import { BUILTIN_ROLES, PERMISSION_CATALOG, ROLE_PERMISSIONS, errors, ulidWithPrefix } from "@forge/core";

const names = ["平台管理员", "组织管理员", "开发者", "运维人员", "审计人员", "普通用户"];

/** Migration/seed only. Existing matrices, including deliberately empty matrices, are never reset. */
export async function initializeRoles(conn: Pick<Connection, "query">): Promise<void> {
  await conn.query("START TRANSACTION");
  try {
    for (const permission of [...PERMISSION_CATALOG, { key: "*", domain: "platform", kind: "action", description: "平台管理员全部权限" }]) {
      await conn.query("INSERT INTO permissions (`key`,domain,kind,description) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE domain=VALUES(domain),kind=VALUES(kind),description=VALUES(description)", [permission.key, permission.domain, permission.kind, permission.description]);
    }
    for (const [i, key] of BUILTIN_ROLES.entries()) {
      const [rows] = await conn.query<RowDataPacket[]>("SELECT id,builtin FROM roles WHERE `key`=? FOR UPDATE", [key]);
      if (rows.length) {
        if (!Number(rows[0]!.builtin)) throw errors.conflict("内置角色代码已被占用");
        continue;
      }
      const id = ulidWithPrefix("rol");
      await conn.query("INSERT INTO roles (id,`key`,name,builtin) VALUES (?,?,?,1)", [id, key, names[i]]);
      for (const code of ROLE_PERMISSIONS[key]) await conn.query("INSERT INTO role_permissions (role_id,permission_key) VALUES (?,?)", [id, code]);
    }
    await conn.query("COMMIT");
  } catch (error) { await conn.query("ROLLBACK"); throw error; }
}
