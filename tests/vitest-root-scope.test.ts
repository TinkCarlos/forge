import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import rootConfig from "../vitest.config";

// P3-08: the root run (node + DB globalSetup) does not collect apps/console tests; they run with the console's own
// vitest config (apps/console/vitest.config.ts, `pnpm --filter console test`). Vitest's default excludes are kept.
describe("P3-08 root vitest scope", () => {
  it("excludes apps/console and keeps the defaults", () => {
    const exclude = rootConfig.test?.exclude ?? [];
    expect(exclude).toContain("apps/console/**");
    for (const pattern of configDefaults.exclude) expect(exclude).toContain(pattern);
  });
});
