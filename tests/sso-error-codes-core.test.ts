import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Item 11: the browser SSO error whitelist lives in a pure @forge/core module (no imports at all, so a client bundle
// can take it without server code, like the K-33 id constants); apps/api/src/routes/auth.ts imports it.
const CORE_FILE = new URL("../packages/core/src/sso-error-codes.ts", import.meta.url);
const AUTH_FILE = new URL("../apps/api/src/routes/auth.ts", import.meta.url);

describe("SSO_ERROR_CODES in @forge/core", () => {
  it("is a pure module: no import / require", () => {
    const src = readFileSync(CORE_FILE, "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(|\bimport\(/);
  });

  it("holds HTP-4003 (= OUTBOUND_BLOCKED_CODE), SSO-1201..1212 and the SYS-9001 fallback", async () => {
    const pure = await import("../packages/core/src/sso-error-codes.js");
    const core = await import("@forge/core");
    expect(core.SSO_ERROR_CODES).toBe(pure.SSO_ERROR_CODES);
    expect(pure.SSO_ERROR_CODES.has(core.OUTBOUND_BLOCKED_CODE)).toBe(true);
    expect(pure.SSO_ERROR_CODES.has(pure.SSO_FALLBACK_CODE)).toBe(true);
    expect([...pure.SSO_ERROR_CODES].sort()).toEqual(
      ["HTP-4003", "SYS-9001", ...Array.from({ length: 12 }, (_, i) => `SSO-12${String(i + 1).padStart(2, "0")}`)].sort(),
    );
  });

  it("auth.ts imports it from @forge/core and no longer defines its own list", () => {
    const src = readFileSync(AUTH_FILE, "utf8");
    expect(src).not.toMatch(/SSO_ERROR_CODES[^=\n]*=\s*new Set/);
    expect(src).not.toMatch(/SSO_FALLBACK_CODE\s*=/);
    const coreImport = src.match(/import\s*\{([^}]*)\}\s*from\s*"@forge\/core"/);
    expect(coreImport?.[1]).toMatch(/\bSSO_ERROR_CODES\b/);
  });
});
