import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import mysql, { type Connection } from "mysql2/promise";
import { beforeAll, afterAll, expect, it } from "vitest";
import { config } from "@forge/core";
import { applyRoles } from "../packages/store/src/migrations/roles.js";
import { applyIdentityLifecycle } from "../packages/store/src/migrations/identity-lifecycle.js";
const name = `forge_identity_race_${randomBytes(5).toString("hex")}_test`;
let conn: Connection;
let createdDatabase=false;
beforeAll(async () => {
  const url = new URL(config.DATABASE_URL);
  if (!url.pathname.endsWith("_test")) throw new Error("test DB required");
  conn = await mysql.createConnection({ host:url.hostname,port:Number(url.port||3306),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),multipleStatements:true });
  await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  createdDatabase=true;
  await conn.query(`USE \`${name}\``);
  await conn.query(readFileSync(new URL("../packages/store/src/schema.sql", import.meta.url), "utf8"));
  await applyRoles(conn);
});
afterAll(async()=>{try{if(createdDatabase)await conn.query(`DROP DATABASE \`${name}\``);}finally{await conn?.end();}});
it("011 is repeatable and refuses malformed identity/audit structures", async () => {
  await applyIdentityLifecycle(conn);
  await applyIdentityLifecycle(conn);
  await conn.query("ALTER TABLE audit_logs MODIFY outcome VARCHAR(16) NULL DEFAULT NULL");
  await expect(applyIdentityLifecycle(conn)).rejects.toMatchObject({ code: "SYS-9001" });
  await conn.query("ALTER TABLE audit_logs MODIFY outcome VARCHAR(16) NOT NULL DEFAULT 'success'");
  await expect(applyIdentityLifecycle(conn)).resolves.toBeUndefined();
  await conn.query("ALTER TABLE users MODIFY idp_issuer VARCHAR(2048) NULL");
  await expect(applyIdentityLifecycle(conn)).rejects.toMatchObject({ code: "SYS-9001" });
  await conn.query("ALTER TABLE users MODIFY idp_issuer VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL");
});
it("two concurrent last-admin revocations cannot remove all login-capable administrators", {timeout:20_000}, () => {
  const url = new URL(config.DATABASE_URL); url.pathname = `/${name}`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "tests/fixtures/account-admin-race.ts"], { cwd:process.cwd(),env:{...process.env,DATABASE_URL:url.href,TEST_DATABASE_URL:url.href,ALLOW_LOCAL_LOGIN:"true",SSO_MODE:"optional",OIDC_ISSUER:"https://identity.race.test",OIDC_CLIENT_ID:"race",OIDC_CLIENT_SECRET:"synthetic-secret",SSO_ROLE_MAPPING_REQUIRED:"true"}, encoding:"utf8" });
  expect(output).toContain("ACCOUNT ADMIN RACE PASS");
});
