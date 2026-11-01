import { readFileSync } from "node:fs";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { ForgeError } from "@forge/core/errors";
import { REVISION_009_TABLES } from "../configuration-tables.js";

export async function applyConfigurationRevision(connection: Pick<Connection, "query">): Promise<void> {
  const sql = readFileSync(new URL("../../drizzle/0001_configuration_revision.sql", import.meta.url), "utf8");
  const statements = sql.split("--> statement-breakpoint").map(part => part.trim()).filter(Boolean);
  const additions = statements.map(statement => {
    const match = /^ALTER TABLE `(\w+)` ADD `revision` int unsigned DEFAULT 1 NOT NULL;$/.exec(statement);
    if (!match || !(REVISION_009_TABLES as readonly string[]).includes(match[1]!)) throw new ForgeError("SYS-9001", { message: "009迁移包含未批准的DDL" });
    return { table: match[1]!, sql: statement };
  });
  if (new Set(additions.map(a => a.table)).size !== REVISION_009_TABLES.length || additions.length !== REVISION_009_TABLES.length) throw new ForgeError("SYS-9001", { message: "009迁移配置表清单不完整" });
  for (const addition of additions) {
    const [rows] = await connection.query<RowDataPacket[]>("SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'revision'", [addition.table]);
    if (!rows.length) await connection.query(addition.sql);
    else if (!/^int(?:\(10\))? unsigned$/.test(String(rows[0]!.COLUMN_TYPE)) || rows[0]!.IS_NULLABLE !== "NO" || String(rows[0]!.COLUMN_DEFAULT) !== "1") {
      throw new ForgeError("SYS-9001", { message: "009迁移发现不兼容的revision列", details: { table: addition.table } });
    }
  }
}
