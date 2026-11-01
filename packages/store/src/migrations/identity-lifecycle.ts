import { readFileSync } from "node:fs";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { ForgeError } from "@forge/core";

const invalid = () => new ForgeError("SYS-9001", { message: "011账号生命周期结构不符合已审查迁移" });
const columns: Record<string, string[]> = { users: ["idp_subject", "idp_issuer"], audit_logs: ["actor_name", "outcome"], auth_login_limits: ["key_hash", "attempts", "window_started_at", "expires_at"] };
const indexes: Record<string, { table: string; columns: string[]; unique: boolean }> = {
  idx_auth_login_limits_expires: { table: "auth_login_limits", columns: ["expires_at"], unique: false },
  PRIMARY: { table: "auth_login_limits", columns: ["key_hash"], unique: true },
  idx_audit_action_page: { table: "audit_logs", columns: ["action", "created_at", "id"], unique: false },
  idx_audit_outcome_page: { table: "audit_logs", columns: ["outcome", "created_at", "id"], unique: false },
};

export async function applyIdentityLifecycle(connection: Pick<Connection, "query">): Promise<void> {
  const statements = readFileSync(new URL("../../drizzle/0003_identity_lifecycle.sql", import.meta.url), "utf8").split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean);
  for (const statement of statements) {
    let match: RegExpExecArray | null;
    if (/^CREATE TABLE `auth_login_limits` \(/.test(statement)) await connection.query(statement.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
    else if ((match = /^ALTER TABLE `(users|audit_logs)` ADD `(\w+)` /.exec(statement)) && columns[match[1]!]!.includes(match[2]!)) {
      const [rows] = await connection.query<RowDataPacket[]>("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [match[1], match[2]]);
      if (!rows.length) await connection.query(statement);
    } else if (statement === "ALTER TABLE `users` MODIFY COLUMN `idp_subject` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;") {
      const [rows] = await connection.query<RowDataPacket[]>("SELECT COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'idp_subject'");
      if (rows[0]?.COLLATION_NAME !== "utf8mb4_0900_bin") await connection.query(statement);
    } else if ((match = /^CREATE INDEX `(idx_\w+)` ON `(\w+)` \(/.exec(statement)) && indexes[match[1]!]?.table === match[2]) {
      const [rows] = await connection.query<RowDataPacket[]>("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?", [match[2], match[1]]);
      if (!rows.length) await connection.query(statement);
    } else throw invalid();
  }
  const snapshot = JSON.parse(readFileSync(new URL("../../drizzle/meta/0003_snapshot.json", import.meta.url), "utf8")) as { tables: Record<string, { columns: Record<string, { type: string; notNull: boolean; default?: string | number }> }> };
  for (const [table, names] of Object.entries(columns)) {
    const [rows] = await connection.query<RowDataPacket[]>("SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [table]);
    for (const name of names) {
      const expected = snapshot.tables[table]!.columns[name]!, row = rows.find(r => r.COLUMN_NAME === name);
      const type = expected.type.replace(/ CHARACTER SET.*$/i, "").toLowerCase();
      const collation = /COLLATE (\w+)/.exec(expected.type)?.[1];
      if (!row || row.COLUMN_TYPE !== type || row.IS_NULLABLE !== (expected.notNull ? "NO" : "YES") || (collation && row.COLLATION_NAME !== collation) || (row.COLUMN_DEFAULT === null ? null : String(row.COLUMN_DEFAULT)) !== (expected.default === undefined ? null : String(expected.default).replace(/^'(.*)'$/, "$1"))) throw invalid();
    }
  }
  for (const [name, expected] of Object.entries(indexes)) {
    const [rows] = await connection.query<RowDataPacket[]>("SELECT COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX", [expected.table, name]);
    if (rows.length !== expected.columns.length || rows.some((row, i) => row.COLUMN_NAME !== expected.columns[i] || Number(row.NON_UNIQUE) !== (expected.unique ? 0 : 1))) throw invalid();
  }
}
