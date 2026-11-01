import { config, ForgeError } from "@forge/core";
import { migrateLegacyCredentials, pool, rewrapSecretVersions } from "@forge/store";
import { requireScriptDatabase } from "./db-guard.js";

const action = process.argv[2];
if (action !== "migrate" && action !== "rewrap") throw new ForgeError("CFG-8501", { message: "凭据维护操作无效" });
requireScriptDatabase(config.DATABASE_URL, `secrets:${action}`);
try {
  const report = (failure: { resourceType: string; id: string; code: string }) => console.error(JSON.stringify(failure));
  const result = await (action === "migrate" ? migrateLegacyCredentials(report) : rewrapSecretVersions(report));
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof ForgeError ? error.code : "SYS-9001" }));
  process.exitCode = 1;
} finally { await pool.end(); }
