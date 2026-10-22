import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

// OPS-026j: db:reset (scripts/reset.ts and the pnpm db:reset chain) on a database not ending with _test / _ux:
// --yes, --force, a bare --confirm-db or a mismatched --confirm-db are refused; only --confirm-db=<exact name> passes.
// Every case points at 127.0.0.1:1, so a case that passes the guard surfaces as ECONNREFUSED (no database is touched).
const root = path.resolve(import.meta.dirname, "..");
const target = "mysql://forge:x@127.0.0.1:1";
function run(cmd: string[], db: string) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "VITEST" && k !== "TEST_DATABASE_URL") env[k] = v;
  Object.assign(env, { DATABASE_URL: `${target}/${db}`, FORGE_ALLOW_RESET: "true", NODE_ENV: "development" });
  const out = spawnSync("pnpm", cmd, { cwd: root, env, encoding: "utf8", timeout: 60000 });
  return { status: out.status, text: `${out.stdout}\n${out.stderr}` };
}
const reset = (db: string, ...args: string[]) => run(["exec", "tsx", "scripts/reset.ts", ...args], db);
const REFUSED = "Refusing to reset";

describe("reset.ts guard (OPS-026j)", () => {
  for (const args of [[], ["--yes"], ["-y"], ["--force"], ["--confirm-db"], ["--confirm-db", "forge"], ["--confirm-db=forge_test"], ["--confirm-db=Forge"], ["--confirm-db="]]) {
    it(`forge ${args.join(" ") || "(no args)"} -> refused before connecting`, () => {
      const out = reset("forge", ...args);
      expect(out.status, out.text).not.toBe(0);
      expect(out.text).toContain(REFUSED);
      expect(out.text).not.toContain("ECONNREFUSED");
    });
  }
  it("forge --confirm-db=forge -> passes the guard (then fails to connect to port 1)", () => {
    const out = reset("forge", "--confirm-db=forge");
    expect(out.text).not.toContain(REFUSED);
    expect(out.text).toContain("ECONNREFUSED");
  });
  for (const db of ["forge_test", "forge_ux"]) {
    it(`${db} without confirmation -> passes the guard`, () => {
      const out = reset(db);
      expect(out.text).not.toContain(REFUSED);
      expect(out.text).toContain("ECONNREFUSED");
    });
  }
  it("pnpm db:reset --confirm-db=forge on forge is still refused at the reset step (pnpm passes args to the last command only)", () => {
    const out = run(["db:reset", "--confirm-db=forge"], "forge");
    expect(out.status).not.toBe(0);
    expect(out.text).toContain(REFUSED);
    expect(out.text).not.toContain("ECONNREFUSED");
  });
});
