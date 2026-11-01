import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, ForgeError, isErrorCode } from "../packages/core/src/errors/index.js";

const root = new URL("../", import.meta.url).pathname;
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(directory, e.name)) : e.name.endsWith(".ts") ? [join(directory, e.name)] : []);
}

describe("FR-DLV-03 error registry", () => {
  it("has complete, immutable metadata and no undefined production codes", () => {
    expect(Object.keys(ERROR_CODES).length).toBeGreaterThanOrEqual(50);
    for (const [code, definition] of Object.entries(ERROR_CODES)) {
      expect(definition.code).toBe(code);
      expect(code).toMatch(/^[A-Z]{2,4}-\d{4}$/);
      for (const field of ["meaning", "userMessage", "remedy", "audience"] as const) expect(definition[field].trim()).not.toBe("");
      expect(definition.httpStatus).toBeGreaterThanOrEqual(400);
      expect(definition.httpStatus).toBeLessThanOrEqual(599);
      expect(typeof definition.retryable).toBe("boolean");
      expect(Object.isFrozen(definition)).toBe(true);
    }
    const missing: string[] = [];
    for (const file of ["packages", "apps/api/src", "apps/worker/src"].flatMap(d => files(join(root, d)))) {
      for (const match of readFileSync(file, "utf8").matchAll(/\b[A-Z]{2,4}-\d{4}\b/g)) if (!isErrorCode(match[0])) missing.push(`${file.slice(root.length)}: ${match[0]}`);
    }
    expect(missing).toEqual([]);
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });

  it("provides defaults, preserves a private cause, and rejects unknown runtime codes", () => {
    const cause = new Error("private diagnostic data");
    const e = new ForgeError("SYS-9003", { details: { reason: "maintenance" }, headers: { "Retry-After": "1" } }, cause);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("SYS-9003");
    expect(e.httpStatus).toBe(503);
    expect(e.retryable).toBe(true);
    expect(e.remedy).toBe(ERROR_CODES[e.code].remedy);
    expect(e.cause).toBe(cause);
    const unknown = Reflect.construct(ForgeError, ["ZZ-0000", { message: "leaked private data", httpStatus: 200 }]) as ForgeError;
    expect([unknown.code, unknown.httpStatus, unknown.message]).toEqual(["SYS-9001", 500, "内部错误"]);
    const invalidStatus = new ForgeError("CFG-8501", { httpStatus: 200, message: "not a success" });
    expect([invalidStatus.code, invalidStatus.httpStatus]).toEqual(["SYS-9001", 500]);
    expect(isErrorCode("toString")).toBe(false);
    expect(isErrorCode(null)).toBe(false);
  });
});

// The normal typecheck must reject a new code until it is registered.
function compileTimeContract(): void {
  // @ts-expect-error nonexistent error codes are forbidden
  new ForgeError("ZZ-0000");
  // @ts-expect-error the legacy positional constructor is forbidden
  new ForgeError("AUTH-1001", "message", 401);
}
void compileTimeContract;
