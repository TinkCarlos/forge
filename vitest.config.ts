import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

const root = import.meta.dirname;
// OPS-026: tests use TEST_DATABASE_URL only. It is passed to the workers as DATABASE_URL, which wins over .env
// (dotenv never overrides an existing variable). tests/global-setup.ts refuses to run without it or on a non-_test DB.
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";

export default defineConfig({
  resolve: {
    alias: {
      "@forge/core": path.resolve(root, "packages/core/src/index.ts"),
      "@forge/store": path.resolve(root, "packages/store/src/index.ts"),
      "@forge/identity": path.resolve(root, "packages/identity/src/index.ts"),
      "@forge/governance": path.resolve(root, "packages/governance/src/index.ts"),
      "@forge/models": path.resolve(root, "packages/models/src/index.ts"),
      "@forge/capabilities": path.resolve(root, "packages/capabilities/src/index.ts"),
      "@forge/runtime": path.resolve(root, "packages/runtime/src/index.ts"),
      "@forge/open-platform": path.resolve(root, "packages/open-platform/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    // P3-08: console tests run with apps/console/vitest.config.ts (pnpm --filter console test), not in this node + DB run.
    exclude: [...configDefaults.exclude, "apps/console/**"],
    globalSetup: ["tests/global-setup.ts"],
    env: { DATABASE_URL: testDatabaseUrl },
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
