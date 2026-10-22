import { defineConfig } from "vitest/config";
import path from "node:path";

const root = import.meta.dirname;

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
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
