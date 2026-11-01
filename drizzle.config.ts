import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "mysql",
  schema: "./packages/store/src/schema/index.ts",
  out: "./packages/store/drizzle",
  strict: true,
});
