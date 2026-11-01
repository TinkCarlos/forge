import { readFileSync } from "node:fs";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { ForgeError } from "@forge/core/errors";

const NEW_TABLES = ["secrets", "secret_versions", "resource_references"];
const NEW_COLUMNS: Record<string, string[]> = { api_apps: ["webhook_secret_id"], llm_providers: ["secret_id", "header_secret_refs_json"], mcp_servers: ["header_secret_refs_json"], tool_sources: ["header_secret_refs_json"] };
const invalid = () => new ForgeError("SYS-9001", { message: "010凭据库结构不符合已审查迁移" });

export async function applySecretVault(connection: Pick<Connection, "query">): Promise<void> {
  const statements = readFileSync(new URL("../../drizzle/0002_secret_vault.sql", import.meta.url), "utf8").split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean);
  for (const statement of statements) {
    let match: RegExpExecArray | null;
    if ((match = /^CREATE TABLE `(\w+)` \(/.exec(statement)) && NEW_TABLES.includes(match[1]!)) {
      await connection.query(statement.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
    } else if ((match = /^ALTER TABLE `(\w+)` ADD `(\w+)` /.exec(statement)) && NEW_COLUMNS[match[1]!]?.includes(match[2]!)) {
      const [rows] = await connection.query<RowDataPacket[]>("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [match[1], match[2]]);
      if (!rows.length) await connection.query(statement);
    } else if (/^ALTER TABLE `secret_versions` ADD CONSTRAINT `fk_secret_versions_secret` FOREIGN KEY \(`secret_id`\) REFERENCES `secrets`\(`id`\) ON DELETE restrict ON UPDATE no action;$/.test(statement)) {
      const [rows] = await connection.query<RowDataPacket[]>("SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_secret_versions_secret'");
      if (!rows.length) await connection.query(statement);
    } else if ((match = /^CREATE INDEX `(idx_\w+)` ON `(\w+)` \((?:`\w+`,?)+\);$/.exec(statement)) && NEW_TABLES.includes(match[2]!)) {
      const [rows] = await connection.query<RowDataPacket[]>("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?", [match[2], match[1]]);
      if (!rows.length) await connection.query(statement);
    } else throw invalid();
  }
  // Fixed snapshot is the reviewed 010 shape, not whatever a future schema happens to contain.
  const snapshot = JSON.parse(readFileSync(new URL("../../drizzle/meta/0002_snapshot.json", import.meta.url), "utf8")) as { tables: Record<string, {
    columns: Record<string, { type: string; notNull: boolean; default?: string | number }>;
    indexes: Record<string, { name: string; columns: string[]; isUnique: boolean }>;
    uniqueConstraints: Record<string, { name: string; columns: string[] }>;
    compositePrimaryKeys: Record<string, { columns: string[] }>;
  }> };
  for (const table of [...NEW_TABLES, ...Object.keys(NEW_COLUMNS)]) {
    const expected = snapshot.tables[table]?.columns;
    if (!expected) throw invalid();
    const [rows] = await connection.query<RowDataPacket[]>("SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [table]);
    for (const name of NEW_TABLES.includes(table) ? Object.keys(expected) : NEW_COLUMNS[table]!) {
      const column = expected[name]!, row = rows.find(r => r.COLUMN_NAME === name);
      const type = column.type.replace(/ CHARACTER SET.*$/i, "").toLowerCase();
      if (!row || row.COLUMN_TYPE !== type || row.IS_NULLABLE !== (column.notNull ? "NO" : "YES") || (/CHARACTER SET ascii/i.test(column.type) && (row.CHARACTER_SET_NAME !== "ascii" || row.COLLATION_NAME !== "ascii_bin"))) throw invalid();
      if (type.startsWith("datetime")) {
        const [expectedDefault, update] = String(column.default ?? "").split(/ ON UPDATE /i);
        const normalize = (value: unknown) => String(value ?? "").replace(/^\((.*)\)$/, "$1").replace(/now\(/i, "current_timestamp(").replace(/\s/g, "").toLowerCase();
        if (normalize(row.COLUMN_DEFAULT) !== normalize(expectedDefault) || /on update/i.test(String(row.EXTRA)) !== Boolean(update) || (update && !normalize(row.EXTRA).includes(`onupdate${normalize(update)}`))) throw invalid();
      } else if ((row.COLUMN_DEFAULT === null ? null : String(row.COLUMN_DEFAULT)) !== (column.default === undefined ? null : String(column.default).replace(/^'(.*)'$/, "$1"))) throw invalid();
    }
    if (!NEW_TABLES.includes(table)) continue;
    const definition = snapshot.tables[table]!;
    const expectedIndexes = [
      ...Object.values(definition.indexes),
      ...Object.values(definition.uniqueConstraints).map(index => ({ ...index, isUnique: true })),
      ...Object.values(definition.compositePrimaryKeys).map(index => ({ name: "PRIMARY", columns: index.columns, isUnique: true })),
    ];
    const [indexes] = await connection.query<RowDataPacket[]>("SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX", [table]);
    for (const expectedIndex of expectedIndexes) {
      const actual = indexes.filter(index => index.INDEX_NAME === expectedIndex.name);
      if (actual.length !== expectedIndex.columns.length || actual.some((index, i) => index.COLUMN_NAME !== expectedIndex.columns[i] || Number(index.NON_UNIQUE) !== (expectedIndex.isUnique ? 0 : 1))) throw invalid();
    }
  }
  const [fk] = await connection.query<RowDataPacket[]>(`SELECT k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA = DATABASE() AS same_schema, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE, r.UPDATE_RULE
    FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.TABLE_NAME = 'secret_versions' AND k.CONSTRAINT_NAME = 'fk_secret_versions_secret'`);
  if (fk.length !== 1 || Number(fk[0]!.same_schema) !== 1 || fk[0]!.COLUMN_NAME !== "secret_id" || fk[0]!.REFERENCED_TABLE_NAME !== "secrets" || fk[0]!.REFERENCED_COLUMN_NAME !== "id" || !["RESTRICT", "NO ACTION"].includes(String(fk[0]!.DELETE_RULE)) || !["RESTRICT", "NO ACTION"].includes(String(fk[0]!.UPDATE_RULE))) throw invalid();
}
