import { describe, expect, it, vi } from "vitest";

// Pure: @forge/core is replaced by the real (import-free) env-mode module, so no config / .env / database is loaded.
vi.mock("@forge/core", async () => {
  const mode = await import("../packages/core/src/env-mode");
  return { isDevLike: mode.isDevLike };
});

const { sessionCookieOptions } = await import("../apps/api/src/plugins/session-cookie");
const { checkResetAllowed, checkSmokeDatabase } = await import("../scripts/db-guard");

describe("K-22 call site: session cookie secure flag", () => {
  it("explicit production -> secure (unchanged)", () => {
    expect(sessionCookieOptions({ NODE_ENV: "production" })).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 8 * 60 * 60 });
  });
  it("NODE_ENV unset / empty / staging -> secure", () => {
    for (const value of [undefined, "", "staging"]) expect(sessionCookieOptions({ NODE_ENV: value }).secure).toBe(true);
    expect(sessionCookieOptions({}).secure).toBe(true);
  });
  it("explicit development / test -> not secure (plain http localhost)", () => {
    expect(sessionCookieOptions({ NODE_ENV: "development" }).secure).toBe(false);
    expect(sessionCookieOptions({ NODE_ENV: "test" }).secure).toBe(false);
  });
});

describe("K-22 call site: scripts/reset.ts guard", () => {
  const allow = { FORGE_ALLOW_RESET: "true" };
  it("explicit production -> refused (unchanged)", () => {
    expect(checkResetAllowed({ NODE_ENV: "production" }, allow).ok).toBe(false);
  });
  it("NODE_ENV unset / staging -> refused even with FORGE_ALLOW_RESET=true", () => {
    expect(checkResetAllowed({}, allow).ok).toBe(false);
    expect(checkResetAllowed({ NODE_ENV: "staging" }, allow).ok).toBe(false);
  });
  it("explicit development / test -> needs FORGE_ALLOW_RESET=true", () => {
    for (const nodeEnv of ["development", "test"]) {
      expect(checkResetAllowed({ NODE_ENV: nodeEnv }, allow)).toEqual({ ok: true });
      expect(checkResetAllowed({ NODE_ENV: nodeEnv }, {}).ok).toBe(false);
      expect(checkResetAllowed({ NODE_ENV: nodeEnv }, { FORGE_ALLOW_RESET: "1" }).ok).toBe(false);
    }
  });
});

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
