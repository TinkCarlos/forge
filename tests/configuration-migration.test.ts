import {applyRunThreadProtocol} from "../packages/store/src/migrations/run-thread-protocol.js";
import {applyMessageManagement} from "../packages/store/src/migrations/message-management.js";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "@forge/core";
import { REVISION_009_TABLES } from "../packages/store/src/configuration-tables.js";
import { applyJobCore } from "../packages/store/src/migrations/job-core.js";
import { applyRoles } from "../packages/store/src/migrations/roles.js";
import { applyIdentityLifecycle } from "../packages/store/src/migrations/identity-lifecycle.js";
import { applySecretVault } from "../packages/store/src/migrations/secret-vault.js";
import { applyConfigurationRevision } from "../packages/store/src/migrations/configuration-revision.js";

const prefix = `forge_rev_${Date.now()}`;
const root = new URL(config.DATABASE_URL);
const names = [`${prefix}_baseline_test`, `${prefix}_bootstrap_test`];
let connection: Connection;
const createdDatabases:string[]=[];
const schema = readFileSync(new URL("../packages/store/src/schema.sql", import.meta.url), "utf8");
const baseline = readFileSync(new URL("../packages/store/drizzle/0000_legacy_baseline.sql", import.meta.url), "utf8");
const columns = async (db: string) => {
  const [rows] = await connection.query<RowDataPacket[]>("SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations' ORDER BY TABLE_NAME, COLUMN_NAME", [db]);
  return rows.map(row => ({ ...row, COLUMN_TYPE: String(row.COLUMN_TYPE).replace(/^tinyint\(1\)$/, "tinyint"), COLUMN_DEFAULT: row.COLUMN_DEFAULT === "now(3)" ? "CURRENT_TIMESTAMP(3)" : row.COLUMN_DEFAULT }));
};
const foreignKeys = async (db: string) => {
  const [rows] = await connection.query<RowDataPacket[]>("SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME", [db]);
  return rows.map(row => ({ ...row }));
};
const indexes = async (db: string) => {
  const [rows] = await connection.query<RowDataPacket[]>("SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations' ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX", [db]);
  return rows.map(row => ({ ...row }));
};
beforeAll(async () => {
  if (!root.pathname.endsWith("_test")) throw new Error("requires test DB");
  connection = await mysql.createConnection({ host: root.hostname, port: Number(root.port || 3306), user: decodeURIComponent(root.username), password: decodeURIComponent(root.password), multipleStatements: true });
  for (const db of names) {await connection.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);createdDatabases.push(db);}
});
afterAll(async () => {
  try {for (const db of createdDatabases) await connection.query(`DROP DATABASE \`${db}\``);}
  finally {await connection?.end();}
});

describe("REV-01: real MySQL migration and Drizzle parity", () => {
  it("upgrades legacy baseline, resumes partial DDL and reruns without losing data", async () => {
    await connection.query(`USE \`${names[0]}\``);
    for (const statement of baseline.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) await connection.query(statement);
    await connection.query("INSERT INTO agents (id, `key`, name) VALUES ('01J00000000000000000REV001', 'kept', 'kept')");
    await connection.query("ALTER TABLE agents ADD revision int unsigned DEFAULT 1 NOT NULL");
    await applyConfigurationRevision(connection);
    await applyConfigurationRevision(connection);
    const [rows] = await connection.query<RowDataPacket[]>("SELECT name, revision FROM agents WHERE `key` = 'kept'");
    expect(rows.map(r => ({ ...r }))).toEqual([{ name: "kept", revision: 1 }]);
    const [revisions] = await connection.query<RowDataPacket[]>("SELECT TABLE_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'revision' ORDER BY TABLE_NAME");
    expect(revisions.map(r => r.TABLE_NAME).sort()).toEqual([...REVISION_009_TABLES].sort());
    for (const row of revisions) expect([row.COLUMN_TYPE, row.IS_NULLABLE, row.COLUMN_DEFAULT]).toEqual(["int unsigned", "NO", "1"]);
  });

  it("bootstrap and generated Drizzle baseline have identical columns and foreign keys", async () => {
    await connection.query(`USE \`${names[0]}\``);
    const partial = readFileSync(new URL("../packages/store/drizzle/0002_secret_vault.sql", import.meta.url), "utf8").split("--> statement-breakpoint")[0]!;
    await connection.query(partial);
    await applySecretVault(connection);
    await applySecretVault(connection);
    await applyIdentityLifecycle(connection);
    await applyIdentityLifecycle(connection);
    await applyRoles(connection);
    await applyJobCore(connection);
    await applyMessageManagement(connection);
    await applyRunThreadProtocol(connection);
    await applyRunThreadProtocol(connection);
    await connection.query(`USE \`${names[1]}\``);
    await connection.query(schema);
    expect(await columns(names[0]!)).toEqual(await columns(names[1]!));
    expect(await foreignKeys(names[0]!)).toEqual(await foreignKeys(names[1]!));
    expect(await indexes(names[0]!)).toEqual(await indexes(names[1]!));
  });

  it("refuses incompatible 010 defaults and indexes instead of accepting a name-only match", async () => {
    await connection.query(`USE \`${names[0]}\``);
    await connection.query("ALTER TABLE secrets ALTER COLUMN revision SET DEFAULT 7");
    try { await expect(applySecretVault(connection)).rejects.toMatchObject({code:"SYS-9001"}); }
    finally { await connection.query("ALTER TABLE secrets ALTER COLUMN revision SET DEFAULT 1"); }
    await connection.query("DROP INDEX idx_secrets_creator ON secrets");
    await connection.query("CREATE INDEX idx_secrets_creator ON secrets (created_by)");
    try { await expect(applySecretVault(connection)).rejects.toMatchObject({code:"SYS-9001"}); }
    finally { await connection.query("DROP INDEX idx_secrets_creator ON secrets"); await connection.query("CREATE INDEX idx_secrets_creator ON secrets (created_by,status,id)"); }
    await expect(applySecretVault(connection)).resolves.toBeUndefined();
    await connection.query("ALTER TABLE secrets ALTER COLUMN created_at DROP DEFAULT");
    try { await expect(applySecretVault(connection)).rejects.toMatchObject({code:"SYS-9001"}); }
    finally { await connection.query("ALTER TABLE secrets ALTER COLUMN created_at SET DEFAULT (CURRENT_TIMESTAMP(3))"); }
    await connection.query("ALTER TABLE secrets MODIFY updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)");
    try { await expect(applySecretVault(connection)).rejects.toMatchObject({code:"SYS-9001"}); }
    finally { await connection.query("ALTER TABLE secrets MODIFY updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)"); }
    await connection.query("ALTER TABLE secret_versions DROP FOREIGN KEY fk_secret_versions_secret");
    await connection.query(`ALTER TABLE secret_versions ADD CONSTRAINT fk_secret_versions_secret FOREIGN KEY (secret_id) REFERENCES \`${names[1]}\`.secrets(id) ON DELETE RESTRICT`);
    try { await expect(applySecretVault(connection)).rejects.toMatchObject({code:"SYS-9001"}); }
    finally {
      await connection.query("ALTER TABLE secret_versions DROP FOREIGN KEY fk_secret_versions_secret");
      await connection.query("ALTER TABLE secret_versions ADD CONSTRAINT fk_secret_versions_secret FOREIGN KEY (secret_id) REFERENCES secrets(id) ON DELETE RESTRICT");
    }
    await expect(applySecretVault(connection)).resolves.toBeUndefined();
  });

  it("refuses incompatible 016 sequence/index definitions rather than accepting names",async()=>{
    await connection.query(`USE \`${names[0]}\``);
    await connection.query("ALTER TABLE threads ALTER COLUMN next_message_seq SET DEFAULT 8");
    try {await expect(applyRunThreadProtocol(connection)).rejects.toMatchObject({code:"SYS-9001"});}
    finally {await connection.query("ALTER TABLE threads ALTER COLUMN next_message_seq SET DEFAULT 1");}
    await connection.query("DROP INDEX idx_runs_engine_status ON runs");
    await connection.query("CREATE INDEX idx_runs_engine_status ON runs (status,runtime_engine,created_at,id)");
    try {await expect(applyRunThreadProtocol(connection)).rejects.toMatchObject({code:"SYS-9001"});}
    finally {await connection.query("DROP INDEX idx_runs_engine_status ON runs");await connection.query("CREATE INDEX idx_runs_engine_status ON runs (runtime_engine,status,created_at,id)");}
    await expect(applyRunThreadProtocol(connection)).resolves.toBeUndefined();
  });

  it("empty bootstrap applies all migrations and records 009 exactly once", { timeout: 60_000 }, async () => {
    const url = new URL(root); url.pathname = `/${names[1]}`;
    const migrate = () => execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], { cwd: new URL("..", import.meta.url), env: { ...process.env, DATABASE_URL: url.href, TEST_DATABASE_URL: url.href }, encoding: "utf8" });
    expect(migrate()).toContain("009_configuration_revision applied");
    expect(migrate()).toContain("009_configuration_revision already applied");
    const [rows] = await connection.query<RowDataPacket[]>(`SELECT version FROM \`${names[1]}\`.schema_migrations WHERE version = '009_configuration_revision'`);
    expect(rows).toHaveLength(1);
  });
  it("re-seeding existing configuration invalidates prior editor revisions", { timeout: 60_000 }, async () => {
    const url = new URL(root); url.pathname = `/${names[1]}`;
    const seed = () => execFileSync(process.execPath, ["--import", "tsx", "scripts/seed.ts"], { cwd: new URL("..", import.meta.url), env: { ...process.env, DATABASE_URL: url.href, TEST_DATABASE_URL: url.href }, encoding: "utf8" });
    seed();
    await connection.query(`USE \`${names[1]}\``);
    const tables = ["org_units", "users", "llm_providers", "llm_models", "skills", "agents", "oidc_role_mappings", "settings"];
    const before = new Map<string, number[]>();
    for (const table of tables) {
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT revision FROM \`${table}\`${table === "settings" ? " WHERE \`key\` <> 'identity.account-lock'" : ""} ORDER BY revision`);
      before.set(table, rows.map(row => Number(row.revision)));
    }
    seed();
    for (const table of tables) {
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT revision FROM \`${table}\`${table === "settings" ? " WHERE \`key\` <> 'identity.account-lock'" : ""} ORDER BY revision`);
      expect(rows.map(row => Number(row.revision)), table).toEqual(before.get(table)!.map(n => ["users","oidc_role_mappings"].includes(table) ? n : n + 1));
    }
  });

  it("refuses an existing incompatible revision column instead of marking the migration applied", async () => {
    await connection.query(`USE \`${names[0]}\``);
    await connection.query("ALTER TABLE settings MODIFY revision INT NOT NULL DEFAULT 1");
    try {
      await expect(applyConfigurationRevision(connection)).rejects.toMatchObject({ code: "SYS-9001" });
    } finally {
      await connection.query("ALTER TABLE settings MODIFY revision INT UNSIGNED NOT NULL DEFAULT 1");
    }
    await expect(applyConfigurationRevision(connection)).resolves.toBeUndefined();
  });

});
