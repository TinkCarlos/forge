import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { errors, MAX_REVISION } from "@forge/core";
import { transaction } from "./db.js";
import { CONFIGURATION_TABLES, type ConfigurationTable, type RevisionExpectation } from "./configuration-tables.js";
import { auditRepo } from "./repositories/audit.js";

export type ConfigurationAudit = Parameters<typeof auditRepo.audit>[0] & { orgUnitId: string | null };
export interface ConfigurationWrite {
  expectedRevision: RevisionExpectation;
  audit?: ConfigurationAudit;
  connection?: PoolConnection;
  beforeWrite?: (connection: PoolConnection) => Promise<void>;
  afterWrite?: (connection: PoolConnection) => Promise<void>;
}

export async function updateConfiguration(table: ConfigurationTable, id: string, fields: Record<string, unknown> | ((connection: PoolConnection) => Promise<Record<string, unknown>>), options: ConfigurationWrite): Promise<number> {
  if (!(CONFIGURATION_TABLES as readonly string[]).includes(table)) throw errors.invalid("未知配置资源");
  const key = table === "settings" ? "key" : "id";
  const write = async (conn: PoolConnection): Promise<number> => {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT revision FROM \`${table}\` WHERE \`${key}\` = ? FOR UPDATE`, [id]);
    const current = Number(rows[0]?.revision);
    if (!rows[0]) throw errors.notFound("配置资源不存在");
    const expected = options.expectedRevision === "system" ? current : options.expectedRevision;
    if (expected !== current) throw errors.conflict("配置已被修改，请重新打开并比较后保存");
    const entries = Object.entries(typeof fields === "function" ? await fields(conn) : fields).filter(([, value]) => value !== undefined);
    if (entries.some(([name]) => !/^[a-z][a-z_]*$/.test(name) || name === "revision" || name === key)) throw errors.invalid("配置字段无效");
    if (options.beforeWrite) await options.beforeWrite(conn);
    if (entries.length) {
      if (current >= MAX_REVISION) throw errors.conflict("资源版本已达到上限");
      await conn.execute(`UPDATE \`${table}\` SET ${entries.map(([name]) => `\`${name}\` = ?`).join(", ")}, revision = revision + 1 WHERE \`${key}\` = ? AND revision = ?`, [...entries.map(([, value]) => value), id, expected] as never[]);
    }
    if (options.afterWrite) await options.afterWrite(conn);
    if (options.audit) await auditRepo.audit(options.audit, conn);
    return current + (entries.length ? 1 : 0);
  };
  return options.connection ? write(options.connection) : transaction(write);
}
