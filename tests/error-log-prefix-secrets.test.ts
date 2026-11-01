import { expect, it } from "vitest";
import { ForgeError } from "../packages/core/src/errors/forge-error.js";
import { logSafeError, redactCredentials } from "../packages/runtime/src/tick-guard.js";

const secrets = [
  `sk-${"a".repeat(36)}`, `ghp_${"b".repeat(36)}`, `fsk_${"c".repeat(43)}`,
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqr",
];
it.each(secrets)("masks a naked credential echoed in a tool error message and stack", secret => {
  const error = new ForgeError("HTP-4001", { message: `MCP 上游失败: ${JSON.stringify({ message: secret })}` });
  const logged = logSafeError(error);
  expect(logged.message).not.toContain(secret);
  expect(logged.stack).not.toContain(secret);
  expect(logged.message).toContain("MCP 上游失败");
  expect(logged.message).toContain("***");
  expect(redactCredentials(`https://user:pass@example.test/?signature=private&reason=${secret}`)).not.toMatch(/user:pass|signature=private/);
});
