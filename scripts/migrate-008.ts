// 008_tool_side_effects (r5 worker takeover). Additive only: every column is added with ALGORITHM=INSTANT, so MySQL
// refuses (ER_ALTER_OPERATION_NOT_SUPPORTED_REASON) instead of silently copying the table when INSTANT is not possible.
// No index is added (an index is not INSTANT). Kept in its own module so tests can run it against probe tables.
// Keep in sync with packages/store/src/schema.sql.
import type { Connection } from "mysql2/promise";

type Queryable = Pick<Connection, "query">;

export interface Tables008 {
  tools: string;
  mcpTools: string;
  toolCalls: string;
  approvals: string;
}

export const TABLES_008: Tables008 = { tools: "tools", mcpTools: "mcp_tools", toolCalls: "tool_calls", approvals: "approvals" };

export async function hasColumn(conn: Queryable, table: string, column: string): Promise<boolean> {
  const [rows] = await conn.query(
    "SELECT 1 AS ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1",
    [table, column],
  );
  return (rows as unknown[]).length > 0;
}

/** Adds the column with ALGORITHM=INSTANT when it is missing. Returns whether it was added. */
export async function addColumnInstant(conn: Queryable, table: string, column: string, definition: string): Promise<boolean> {
  if (await hasColumn(conn, table, column)) return false;
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}, ALGORITHM=INSTANT`);
  return true;
}

/**
 * tools / mcp_tools / tool_calls .read_only (0 = has side effects, the safe default), approvals.reason (existing rows
 * read the default 'policy', no UPDATE), tool_calls.call_id / model_step / step_index (Q5, nullable, not backfilled).
 * Only tools.read_only is backfilled, from the HTTP method (GET/HEAD = read-only), and only when the column is new.
 */
export async function applyToolSideEffects(conn: Queryable, tables: Tables008 = TABLES_008): Promise<void> {
  if (await addColumnInstant(conn, tables.tools, "read_only", "TINYINT(1) NOT NULL DEFAULT 0")) {
    await conn.query(`UPDATE \`${tables.tools}\` SET read_only = 1 WHERE method IN ('GET', 'HEAD')`);
  }
  await addColumnInstant(conn, tables.mcpTools, "read_only", "TINYINT(1) NOT NULL DEFAULT 0");
  await addColumnInstant(conn, tables.toolCalls, "read_only", "TINYINT(1) NOT NULL DEFAULT 0");
  await addColumnInstant(conn, tables.approvals, "reason", "VARCHAR(16) NOT NULL DEFAULT 'policy'");
  await addColumnInstant(conn, tables.toolCalls, "call_id", "VARCHAR(191) NULL");
  await addColumnInstant(conn, tables.toolCalls, "model_step", "INT UNSIGNED NULL");
  await addColumnInstant(conn, tables.toolCalls, "step_index", "INT UNSIGNED NULL");
}
