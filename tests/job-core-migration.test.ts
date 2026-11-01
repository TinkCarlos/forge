import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config, newId } from "@forge/core";
import { applyJobCore, jobCoreShape } from "../packages/store/src/migrations/job-core.js";
const name = `forge_job_core_${randomBytes(5).toString("hex")}_test`;
let conn: Connection;
let createdDatabase=false;
beforeAll(async () => {
  const u = new URL(config.DATABASE_URL);
  if (!u.pathname.endsWith("_test")) throw new Error("Requires isolated test database");
  conn = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), multipleStatements: true });
  await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET latin1`);
  createdDatabase=true;
  await conn.query(`USE \`${name}\``);
  const sql = readFileSync(new URL("../packages/store/src/schema.sql", import.meta.url), "utf8");
  await conn.query(sql.slice(0, sql.indexOf("-- Job core expand (014)")));
});
afterAll(async()=>{try{if(createdDatabase)await conn.query(`DROP DATABASE \`${name}\``);}finally{await conn?.end();}});
describe("014 Job core forward-only migration on real MySQL", () => {
  it("resumes partially created tables and reruns without changing data or metadata", async () => {
    const sql = readFileSync(new URL("../packages/store/drizzle/0005_job_core_expand.sql", import.meta.url), "utf8");
    await conn.query(sql.split("--> statement-breakpoint")[0]!);
    await applyJobCore(conn);
    const before = await jobCoreShape(conn);
    const id = newId();
    await conn.query("INSERT INTO job_definitions (id,`key`,name,business_type,draft_json) VALUES (?,'kept','保留','technical','{}')", [id]);
    await applyJobCore(conn);
    expect(await jobCoreShape(conn)).toEqual(before);
    const [rows] = await conn.query<RowDataPacket[]>("SELECT id,revision,status FROM job_definitions WHERE id=?", [id]);
    expect(rows[0]).toMatchObject({ id, revision: 1, status: "disabled" });
  });
  it("fails closed on a changed CHECK, index order, nullability or column default", async () => {
    await conn.query("ALTER TABLE job_definitions ALTER COLUMN revision SET DEFAULT 2");
    await expect(applyJobCore(conn)).rejects.toMatchObject({ code: "SYS-9001" });
    await conn.query("ALTER TABLE job_definitions ALTER COLUMN revision SET DEFAULT 1");
    await conn.query("ALTER TABLE job_definitions DROP CHECK ck_job_definitions_status");
    await conn.query("ALTER TABLE job_definitions ADD CONSTRAINT ck_job_definitions_status CHECK(status IN ('active','disabled','deleted','unsafe'))");
    await expect(applyJobCore(conn)).rejects.toMatchObject({ code: "SYS-9001" });
    await conn.query("ALTER TABLE job_definitions DROP CHECK ck_job_definitions_status");
    await conn.query("ALTER TABLE job_definitions ADD CONSTRAINT ck_job_definitions_status CHECK(status IN ('active','disabled','deleted'))");
    await conn.query("DROP INDEX idx_job_definitions_org ON job_definitions");
    await conn.query("CREATE INDEX idx_job_definitions_org ON job_definitions (status,owner_org_unit_id,id)");
    await expect(applyJobCore(conn)).rejects.toMatchObject({ code: "SYS-9001" });
    await conn.query("DROP INDEX idx_job_definitions_org ON job_definitions");
    await conn.query("CREATE INDEX idx_job_definitions_org ON job_definitions (owner_org_unit_id,status,id)");
    await expect(applyJobCore(conn)).resolves.toBeUndefined();
  });
  it("bootstrap and upgrade have identical reviewed shape, charset, comments and constraints", async () => {
    const before = await jobCoreShape(conn);
    await conn.query("DROP TABLE job_app_grants,job_step_attempts,job_steps,job_events,outbox_events,job_executions,job_definition_versions,job_definitions");
    const sql = readFileSync(new URL("../packages/store/src/schema.sql", import.meta.url), "utf8");
    await conn.query(sql.slice(sql.indexOf("-- Job core expand (014)")));
    expect(await jobCoreShape(conn)).toEqual(before);
    await expect(applyJobCore(conn)).resolves.toBeUndefined();
    await expect(conn.query("INSERT INTO job_definitions(id,`key`,name,business_type,draft_json,status) VALUES (?,'bad','bad','technical','{}','unsafe')", [newId()])).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  });
});
