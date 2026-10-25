import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { query } from "@forge/store";

// SS-13: migration 007_auth_sessions is additive (CREATE TABLE IF NOT EXISTS) and can be re-run. It runs here only
// against the vitest database, which the globalSetup / db.ts guards already pin to a *_test name.
const root = path.resolve(import.meta.dirname, "..");
const migrate = () =>
  execFileSync(path.join(root, "node_modules/.bin/tsx"), ["scripts/migrate.ts"], { cwd: root, env: { ...process.env, NODE_ENV: "test" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("SS-13: migration 007_auth_sessions", () => {
  it("SS-13: runs twice on the _test DB, records 007 once and leaves both tables with the approved columns", { timeout: 60_000 }, async () => {
    const first = migrate();
    const second = migrate();
    expect(first + second).toMatch(/007_auth_sessions (applied|already applied)/);
    expect(second).toContain("Migration 007_auth_sessions already applied");
    const versions = await query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = ?", ["007_auth_sessions"]);
    expect(versions).toHaveLength(1);
    const columns = await query<{ TABLE_NAME: string; COLUMN_NAME: string }>(
      "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('auth_sessions', 'auth_oidc_states') ORDER BY TABLE_NAME, ORDINAL_POSITION",
    );
    const byTable = (name: string) => columns.filter((column) => column.TABLE_NAME === name).map((column) => column.COLUMN_NAME);
    expect(byTable("auth_sessions")).toEqual(["token_hash", "user_id", "csrf_token", "created_at", "last_seen_at", "expires_at"]);
    expect(byTable("auth_oidc_states")).toEqual(["state_hash", "verifier", "nonce", "return_to", "created_at", "expires_at"]);
  });
});
