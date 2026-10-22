import { describe, expect, it } from "vitest";
import { config } from "@forge/core";
import { checkScriptDatabase, checkTestDatabase, confirmDbArg, databaseName } from "../scripts/db-guard.js";

// OPS-026: tests only ever run against an explicit *_test database; seed / migrate ask for an explicit confirmation
// before writing to anything that is not *_test or *_ux. Pure checks: nothing here connects to a database.
const url = (db: string) => `mysql://forge:pw@127.0.0.1:3306/${db}`;

describe("checkTestDatabase (vitest globalSetup) — OPS-026a~e", () => {
  it("a: nothing set -> refused", () => expect(checkTestDatabase({}).ok).toBe(false));
  it("b: only DATABASE_URL=.../forge -> refused", () => expect(checkTestDatabase({ DATABASE_URL: url("forge") }).ok).toBe(false));
  it("c: TEST_DATABASE_URL=.../forge -> refused", () => expect(checkTestDatabase({ TEST_DATABASE_URL: url("forge") }).ok).toBe(false));
  it("d: TEST_DATABASE_URL=.../forge_test -> allowed", () => expect(checkTestDatabase({ TEST_DATABASE_URL: url("forge_test") }).ok).toBe(true));
  it("e: environment as loaded from the main workspace .env (DATABASE_URL=forge, other settings, no TEST_DATABASE_URL) -> refused", () => {
    const fromDotEnv = { NODE_ENV: "development", PORT: "3100", DATABASE_URL: url("forge"), FORGE_ADMIN_PASSWORD: "x", TOOL_ALLOW_PRIVATE_NETWORK: "true" };
    expect(checkTestDatabase(fromDotEnv).ok).toBe(false);
  });

  it("refuses when TEST_DATABASE_URL is missing, even if DATABASE_URL is set (no inheritance from .env)", () => {
    const result = checkTestDatabase({ DATABASE_URL: url("forge_test") });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("TEST_DATABASE_URL");
  });
  it("refuses the dev database forge", () => {
    const result = checkTestDatabase({ TEST_DATABASE_URL: url("forge") });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("forge");
    expect((result as { reason: string }).reason).toContain("_test");
  });
  for (const db of ["forge_ux", "forge_smoke", "forge_testing", "test_forge", "forge_test_ux", ""]) {
    it(`refuses ${JSON.stringify(db)}`, () => expect(checkTestDatabase({ TEST_DATABASE_URL: url(db) }).ok).toBe(false));
  }
  it("refuses an unparseable URL", () => expect(checkTestDatabase({ TEST_DATABASE_URL: "not a url" }).ok).toBe(false));
  it("allows forge_test and returns the URL to use", () => {
    expect(checkTestDatabase({ TEST_DATABASE_URL: url("forge_test") })).toEqual({ ok: true, url: url("forge_test"), database: "forge_test" });
  });
  it("no bypass: former escape hatches do not open a non-test database", () => {
    expect(checkTestDatabase({ TEST_DATABASE_URL: url("forge"), FORGE_ALLOW_NON_TEST_DB: "1" }).ok).toBe(false);
    expect(checkTestDatabase({ TEST_DATABASE_URL: url("forge_ux"), FORGE_ALLOW_NON_TEST_DB: "1" }).ok).toBe(false);
  });
});

describe("checkScriptDatabase (seed / migrate) — OPS-026f", () => {
  it("*_test passes without confirmation", () => expect(checkScriptDatabase(url("forge_test"), []).ok).toBe(true));
  it("*_ux passes without confirmation", () => expect(checkScriptDatabase(url("forge_ux"), []).ok).toBe(true));
  it("forge without --confirm-db is refused", () => expect(checkScriptDatabase(url("forge"), []).ok).toBe(false));
  it("--confirm-db that does not match the target is refused", () => {
    expect(checkScriptDatabase(url("forge"), ["--confirm-db=forge_test"]).ok).toBe(false);
    expect(checkScriptDatabase(url("forge"), ["--confirm-db=Forge"]).ok).toBe(false);
    expect(checkScriptDatabase(url("forge"), ["--confirm-db="]).ok).toBe(false);
  });
  it("generic yes switches are not a confirmation", () => {
    for (const argv of [["--yes"], ["-y"], ["--confirm-db"], ["--force"], ["--confirm-db", "forge"]]) expect(checkScriptDatabase(url("forge"), argv).ok).toBe(false);
  });
  it("--confirm-db=<exact name> passes", () => expect(checkScriptDatabase(url("forge"), ["--confirm-db=forge"]).ok).toBe(true));
  it("env variables are not a confirmation", () => expect(checkScriptDatabase(url("forge"), []).ok).toBe(false));
  it("confirmDbArg / databaseName parsing", () => {
    expect(confirmDbArg(["a", "--confirm-db=x", "--confirm-db=y"])).toBe("y");
    expect(confirmDbArg(["--yes"])).toBeNull();
    expect(databaseName(url("forge_test"))).toBe("forge_test");
    expect(databaseName("mysql://u:p@h/db_x?ssl=true")).toBe("db_x");
  });
});

describe("this test run", () => {
  it("workers see TEST_DATABASE_URL as DATABASE_URL (a *_test database), not the .env value", () => {
    expect(databaseName(config.DATABASE_URL)).toMatch(/_test$/);
    expect(config.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  });
});
