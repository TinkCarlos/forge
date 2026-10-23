import mysql from "mysql2/promise";
import { config } from "@forge/core";
import { checkResetAllowed, requireScriptDatabase } from "./db-guard.js";

// K-22: reset only runs with an explicit NODE_ENV=development|test (unset is treated like production) and FORGE_ALLOW_RESET=true.
const allowed = checkResetAllowed(config, process.env);
if (!allowed.ok) {
  console.error(`Refusing to reset: ${allowed.reason}`);
  process.exit(1);
}

// OPS-026: dropping a database not named *_test / *_ux also needs --confirm-db=<name> (checked before connecting).
requireScriptDatabase(config.DATABASE_URL, "reset");

const url = new URL(config.DATABASE_URL);
const database = url.pathname.replace(/^\//, "");
const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  multipleStatements: true,
});
try {
  await connection.query(`DROP DATABASE IF EXISTS \`${database.replaceAll("`", "``")}\``);
  await connection.query(`CREATE DATABASE \`${database.replaceAll("`", "``")}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  console.log(`Reset database ${database}`);
} finally {
  await connection.end();
}
