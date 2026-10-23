import { describe, expect, it } from "vitest";
import { checkSmokeDatabase } from "../scripts/db-guard";

describe("K-21: smoke-isolated database guard", () => {
  const base = "mysql://u:placeholder@127.0.0.1:1/forge_dev";
  const noUrl = (reason: string) => expect(reason).not.toMatch(/mysql:\/\/|placeholder/);
  it("DATABASE_URL missing / blank -> refused, names the variable only", () => {
    for (const value of [undefined, "", "  "]) {
      const result = checkSmokeDatabase({ DATABASE_URL: value });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("DATABASE_URL");
        noUrl(result.reason);
      }
    }
  });
  it("default FORGE_SMOKE_DB forge_test -> ok, only the database name changes", () => {
    const result = checkSmokeDatabase({ DATABASE_URL: base });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.database).toBe("forge_test");
      expect(new URL(result.url).host).toBe("127.0.0.1:1");
    }
  });
  it("FORGE_SMOKE_DB not ending with _test (incl. _smoke, _ux, forge) -> refused", () => {
    for (const db of ["forge", "forge_smoke", "forge_ux", "forge_testing", ""]) {
      const result = checkSmokeDatabase({ DATABASE_URL: base, FORGE_SMOKE_DB: db });
      expect(result.ok, db).toBe(false);
      if (!result.ok) noUrl(result.reason);
    }
  });
  it("smoke database equal to the DATABASE_URL database -> refused", () => {
    expect(checkSmokeDatabase({ DATABASE_URL: "mysql://u:p@127.0.0.1:1/forge_test" }).ok).toBe(false);
  });
  it("malformed DATABASE_URL -> refused without echoing it", () => {
    const result = checkSmokeDatabase({ DATABASE_URL: "not a url placeholder" });
    expect(result.ok).toBe(false);
    if (!result.ok) noUrl(result.reason);
  });
});
