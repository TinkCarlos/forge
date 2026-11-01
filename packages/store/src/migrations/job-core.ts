import { readFileSync } from "node:fs";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { ForgeError } from "@forge/core/errors";

export const JOB_CORE_TABLES = ["job_app_grants", "job_definition_versions", "job_definitions", "job_events", "job_executions", "job_step_attempts", "job_steps", "outbox_events"] as const;
type MigrationConnection = Pick<Connection, "query">;
export async function reviewedSchemaShape(conn: MigrationConnection, tables: readonly string[]): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    const [columns] = await conn.query<RowDataPacket[]>("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", [table]);
    const [indexes] = await conn.query<RowDataPacket[]>("SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX", [table]);
    const [foreignKeys] = await conn.query<RowDataPacket[]>(`SELECT k.CONSTRAINT_NAME,k.COLUMN_NAME,k.ORDINAL_POSITION,k.REFERENCED_TABLE_SCHEMA=DATABASE() AS SAME_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.DELETE_RULE,r.UPDATE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.TABLE_NAME=? ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION`, [table]);
    const [checks] = await conn.query<RowDataPacket[]>(`SELECT t.CONSTRAINT_NAME,t.ENFORCED,c.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.CONSTRAINT_SCHEMA=DATABASE() AND t.TABLE_NAME=? ORDER BY t.CONSTRAINT_NAME`, [table]);
    const [options] = await conn.query<RowDataPacket[]>("SELECT ENGINE,TABLE_COLLATION,TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [table]);
    // MySQL 8.0 and 8.4 may spell the same defaults and TINYINT type differently.
    result[table] = { columns: columns.map(row => ({ ...row, COLUMN_TYPE: String(row.COLUMN_TYPE).replace(/^tinyint\(1\)$/, "tinyint"), COLUMN_DEFAULT: row.COLUMN_DEFAULT === "now(3)" ? "CURRENT_TIMESTAMP(3)" : row.COLUMN_DEFAULT })), indexes, foreignKeys, checks, options };
  }
  return result;
}
export const jobCoreShape = (conn: MigrationConnection) => reviewedSchemaShape(conn, JOB_CORE_TABLES);
export async function applyJobCore(conn: MigrationConnection): Promise<void> {
  const statements = readFileSync(new URL("../../drizzle/0005_job_core_expand.sql", import.meta.url), "utf8").split("--> statement-breakpoint").map(part => part.trim()).filter(Boolean);
  for (const statement of statements) {
    let match: RegExpExecArray | null;
    if ((match = /^CREATE TABLE `(\w+)` \(/.exec(statement)) && (JOB_CORE_TABLES as readonly string[]).includes(match[1]!)) {
      await conn.query(statement.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
    } else if ((match = /^ALTER TABLE `(\w+)` ADD CONSTRAINT `(\w+)` FOREIGN KEY/.exec(statement)) && (JOB_CORE_TABLES as readonly string[]).includes(match[1]!)) {
      const [rows] = await conn.query<RowDataPacket[]>("SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=?", [match[1], match[2]]);
      if (!rows.length) await conn.query(statement);
    } else if ((match = /^CREATE INDEX `(\w+)` ON `(\w+)` /.exec(statement)) && (JOB_CORE_TABLES as readonly string[]).includes(match[2]!)) {
      const [rows] = await conn.query<RowDataPacket[]>("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?", [match[2], match[1]]);
      if (!rows.length) await conn.query(statement);
    } else throw new ForgeError("SYS-9001", { message: "014迁移包含未批准的DDL" });
  }
  const expected: unknown = JSON.parse(readFileSync(new URL("./job-core-shape.json", import.meta.url), "utf8"));
  if (JSON.stringify(await jobCoreShape(conn)) !== JSON.stringify(expected)) throw new ForgeError("SYS-9001", { message: "014 Job结构与已审查迁移不符" });
}
