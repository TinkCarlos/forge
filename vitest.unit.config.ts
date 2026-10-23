import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Pure unit tests only (no database, no .env): skips the TEST_DATABASE_URL globalSetup guard and is limited to an
// explicit list of files that import no DB module. Usage: pnpm exec vitest run --config vitest.unit.config.ts
export default defineConfig({
  resolve: base.resolve,
  test: {
    environment: "node",
    include: ["tests/config-required.test.ts", "tests/tick-backoff.test.ts", "tests/env-mode-callsites.test.ts", "tests/log-sanitize.test.ts", "tests/not-found-console.test.ts"],
    pool: "forks",
  },
});
