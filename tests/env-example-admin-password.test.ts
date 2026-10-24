import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXAMPLE_ADMIN_PASSWORDS } from "../packages/core/src/config-schema";

// OPS-007 follow-up: production refuses the example admin password only if EXAMPLE_ADMIN_PASSWORDS really contains
// the value shipped in .env.example. If someone edits one without the other, the guard silently stops working.
function exampleValue(name: string): string | undefined {
  const text = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (match && match[1] === name) return match[2].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

describe(".env.example FORGE_ADMIN_PASSWORD", () => {
  it("is listed in EXAMPLE_ADMIN_PASSWORDS so production refuses it", () => {
    const value = exampleValue("FORGE_ADMIN_PASSWORD");
    expect(value, ".env.example must define FORGE_ADMIN_PASSWORD").toBeTruthy();
    expect(EXAMPLE_ADMIN_PASSWORDS).toContain(value);
  });
});
