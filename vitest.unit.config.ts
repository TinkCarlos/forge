import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Pure unit tests only (no database, no .env): skips the TEST_DATABASE_URL globalSetup guard and is limited to an
// explicit list of files that import no DB module (plus the legacy-console static check FE-XSS-01, which only reads
// apps/console/public/app.js with node:fs). Usage: pnpm exec vitest run --config vitest.unit.config.ts
export default defineConfig({
  resolve: base.resolve,
  test: {
    environment: "node",
    include: ["tests/config-required.test.ts", "tests/tick-backoff.test.ts", "tests/env-mode-callsites.test.ts", "tests/log-sanitize.test.ts", "tests/not-found-console.test.ts", "tests/approval-decide-execute-reject.test.ts", "tests/static-upgrade.test.ts", "tests/config-hardening.test.ts", "tests/audit-scope.test.ts", "tests/input-schema.test.ts", "apps/console/src/legacy/app-inline-handlers.test.ts"],
    pool: "forks",
  },
});
