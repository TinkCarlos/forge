import fs from "node:fs";
import path from "node:path";
import mysql, { type Connection } from "mysql2/promise";
import { config } from "@forge/core";

const dbUrl = new URL(config.DATABASE_URL);
const connection = await mysql.createConnection({
  host: dbUrl.hostname,
  port: Number(dbUrl.port || 3306),
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: dbUrl.pathname.replace(/^\//, ""),
  multipleStatements: true,
  timezone: "Z",
});

async function hasColumn(conn: Connection, table: string, column: string): Promise<boolean> {
  const [rows] = await conn.query(
    "SELECT 1 AS ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1",
    [table, column],
  );
  return (rows as unknown[]).length > 0;
}

async function hasIndex(conn: Connection, table: string, index: string): Promise<boolean> {
  const [rows] = await conn.query(
    "SELECT 1 AS ok FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1",
    [table, index],
  );
  return (rows as unknown[]).length > 0;
}

async function applyRuntimeLease(conn: Connection): Promise<void> {
  if (!(await hasColumn(conn, "runs", "claimed_by"))) {
    await conn.query("ALTER TABLE runs ADD COLUMN claimed_by VARCHAR(128) NULL");
  }
  if (!(await hasColumn(conn, "runs", "lease_expires_at"))) {
    await conn.query("ALTER TABLE runs ADD COLUMN lease_expires_at DATETIME(3) NULL");
  }
  if (!(await hasColumn(conn, "runs", "heartbeat_at"))) {
    await conn.query("ALTER TABLE runs ADD COLUMN heartbeat_at DATETIME(3) NULL");
  }
  if (!(await hasIndex(conn, "runs", "idx_runs_lease"))) {
    await conn.query("ALTER TABLE runs ADD KEY idx_runs_lease (status, lease_expires_at)");
  }
  if (!(await hasColumn(conn, "tool_calls", "idempotency_key"))) {
    await conn.query("ALTER TABLE tool_calls ADD COLUMN idempotency_key VARCHAR(191) NULL");
  }
  if (!(await hasColumn(conn, "tool_calls", "attempt"))) {
    await conn.query("ALTER TABLE tool_calls ADD COLUMN attempt INT UNSIGNED NOT NULL DEFAULT 1");
  }
  if (!(await hasIndex(conn, "tool_calls", "uk_tool_calls_run_idem"))) {
    await conn.query("ALTER TABLE tool_calls ADD UNIQUE KEY uk_tool_calls_run_idem (run_id, idempotency_key)");
  }
  await conn.query(`CREATE TABLE IF NOT EXISTS run_steps (
    id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    run_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    seq INT UNSIGNED NOT NULL,
    type VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'running',
    tool_call_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
    summary_json JSON NULL,
    error_code VARCHAR(16) NULL,
    input_tokens INT UNSIGNED NOT NULL DEFAULT 0,
    output_tokens INT UNSIGNED NOT NULL DEFAULT 0,
    cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ended_at DATETIME(3) NULL,
    UNIQUE KEY uk_run_steps (run_id, seq),
    KEY idx_run_steps_type (run_id, type),
    CONSTRAINT fk_run_steps_run FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

async function applyReliability(conn: Connection): Promise<void> {
  await conn.query(`CREATE TABLE IF NOT EXISTS idempotency_keys (
    id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    scope VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(200) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    status_code INT NOT NULL DEFAULT 0,
    response_json JSON NULL,
    run_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
    expires_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_idempotency_scope_key (scope, idempotency_key),
    KEY idx_idempotency_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  await conn.query(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    app_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload_json JSON NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at DATETIME(3) NOT NULL,
    response_status INT NULL,
    error_message VARCHAR(512) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    delivered_at DATETIME(3) NULL,
    UNIQUE KEY uk_webhook_delivery_event (app_id, event_id),
    KEY idx_webhook_delivery_due (status, next_attempt_at),
    CONSTRAINT fk_webhook_deliveries_app FOREIGN KEY (app_id) REFERENCES api_apps (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

try {
  await connection.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(128) NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  );
  const [appliedRows] = await connection.query("SELECT version FROM schema_migrations");
  const applied = new Set((appliedRows as Array<{ version: string }>).map((row) => row.version));

  if (!applied.has("001_init")) {
    const sql = fs.readFileSync(path.resolve(process.cwd(), "packages/store/src/schema.sql"), "utf8");
    await connection.query(sql);
    await connection.query("INSERT INTO schema_migrations (version) VALUES (?)", ["001_init"]);
    console.log("Migration 001_init applied");
  } else {
    console.log("Migration 001_init already applied");
  }

  if (!applied.has("002_runtime_lease")) {
    await applyRuntimeLease(connection);
    await connection.query("INSERT INTO schema_migrations (version) VALUES (?)", ["002_runtime_lease"]);
    console.log("Migration 002_runtime_lease applied");
  } else {
    console.log("Migration 002_runtime_lease already applied");
  }

  if (!applied.has("003_reliability")) {
    await applyReliability(connection);
    await connection.query("INSERT INTO schema_migrations (version) VALUES (?)", ["003_reliability"]);
    console.log("Migration 003_reliability applied");
  } else {
    console.log("Migration 003_reliability already applied");
  }

  if (!applied.has("004_schedule_identity")) {
    await applyScheduleIdentity(connection);
    await connection.query("INSERT INTO schema_migrations (version) VALUES (?)", ["004_schedule_identity"]);
    console.log("Migration 004_schedule_identity applied");
  } else {
    console.log("Migration 004_schedule_identity already applied");
  }
} finally {
  await connection.end();
}
