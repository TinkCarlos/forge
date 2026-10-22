import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

// AC / OPS-026i: second line of defence behind globalSetup. Under vitest (VITEST set) the store refuses to create its
// pool for a database not ending with _test, before any connection — so a test run that bypasses globalSetup
// (other config file, IDE runner, direct worker) still cannot reach forge. Outside vitest nothing changes.
// Port 1 on loopback: any connection attempt would surface as ECONNREFUSED instead of the guard message.
const root = path.resolve(import.meta.dirname, "..");
const importStore = (env: Record<string, string | undefined>) => {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "VITEST" && k !== "DATABASE_URL" && k !== "TEST_DATABASE_URL") clean[k] = v;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  return spawnSync("pnpm", ["exec", "tsx", "-e", "import('./packages/store/src/db.ts').then(async (m) => { console.log('POOL_CREATED'); await m.pool.end(); }, (e) => { console.error(String(e?.message ?? e)); process.exit(1); })"], { cwd: root, env: clean, encoding: "utf8", timeout: 30000 });
};
const url = (db: string) => `mysql://forge:x@127.0.0.1:1/${db}`;

describe("store pool guard under vitest (AC, OPS-026i)", () => {
  for (const db of ["forge", "forge_ux", "forge_testing"]) {
    it(`VITEST set + ${db} -> refused before connecting`, () => {
      const out = importStore({ VITEST: "true", DATABASE_URL: url(db) });
      expect(out.status, out.stdout + out.stderr).not.toBe(0);
      expect(out.stderr).toContain("[test DB guard]");
      expect(out.stdout).not.toContain("POOL_CREATED");
      expect(out.stderr).not.toContain("ECONNREFUSED");
    });
  }
  it("VITEST set + forge_test -> pool created", () => {
    const out = importStore({ VITEST: "true", DATABASE_URL: url("forge_test") });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("POOL_CREATED");
  });
  it("outside vitest (no VITEST) + forge -> unchanged, pool created", () => {
    const out = importStore({ DATABASE_URL: url("forge") });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("POOL_CREATED");
  });
  it("this worker itself runs on a _test database", () => {
    expect(new URL(process.env.DATABASE_URL!).pathname).toMatch(/_test$/);
    expect(process.env.VITEST).toBeTruthy();
  });
});
