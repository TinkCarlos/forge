import { describe, expect, it } from "vitest";
import { RETURN_TO_FALLBACK, safeReturnTo } from "../apps/api/src/plugins/return-to.js";

// S-30: OIDC returnTo must stay on this site. Anything that is not a single-slash local path resolving to our own
// origin falls back to /next/.
const ORIGIN = "https://forge.example.com";

describe("safeReturnTo (S-30)", () => {
  const rejected: Array<[string, unknown]> = [
    ["protocol-relative //", "//evil.example"],
    ["protocol-relative with path", "//evil.example/next/"],
    ["backslash /\\", "/\\evil.example"],
    ["backslash /\\\\", "/\\\\evil.example"],
    ["encoded //", "/%2F%2Fevil.example"],
    ["encoded /\\", "/%5Cevil.example"],
    ["encoded lowercase", "/%2f%2fevil.example"],
    ["absolute https", "https://evil.example"],
    ["absolute http same host but other scheme", "http://forge.example.com/next/"],
    ["javascript:", "javascript:alert(1)"],
    ["control char newline", "/next/\nLocation: https://evil.example"],
    ["control char tab", "/\t/evil.example"],
    ["control char NUL", "/next/\u0000x"],
    ["DEL", "/next/\u007f"],
    ["relative without slash", "next/x"],
    ["empty", ""],
    ["non-string", 42],
    ["undefined", undefined],
  ];
  for (const [name, value] of rejected) {
    it(`rejects ${name}`, () => expect(safeReturnTo(value, ORIGIN)).toBe(RETURN_TO_FALLBACK));
  }

  for (const value of ["/next/x", "/next/agents?tab=runs#top", "/", "/next/"]) {
    it(`keeps ${value}`, () => expect(safeReturnTo(value, ORIGIN)).toBe(value));
  }

  it("fallback is /next/", () => expect(RETURN_TO_FALLBACK).toBe("/next/"));
});
