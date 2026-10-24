// Root lint (item 10): type-aware @typescript-eslint/no-floating-promises over the server code (apps/api, apps/worker,
// packages/*). Only this rule is enabled; apps/console keeps its own eslint.config.js and is not linted from here.
// Run: pnpm exec eslint apps/api apps/worker packages
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "apps/console/**"] },
  {
    files: ["apps/api/**/*.ts", "apps/worker/**/*.ts", "packages/*/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    // Existing `eslint-disable no-control-regex` comments target rules this config does not enable; not reported here.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: { "@typescript-eslint/no-floating-promises": "error" },
  },
);
