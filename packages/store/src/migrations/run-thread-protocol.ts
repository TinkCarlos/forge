import { readFileSync } from "node:fs";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { ForgeError } from "@forge/core/errors";
import { reviewedSchemaShape } from "./job-core.js";

const TABLES = ["messages", "runs", "threads"] as const;
export const runThreadShape = (conn: Pick<Connection,"query">) => reviewedSchemaShape(conn,TABLES);
export async function applyRunThreadProtocol(conn: Pick<Connection,"query">): Promise<void> {
  const statements = readFileSync(new URL("../../drizzle/0007_run_thread_protocol.sql",import.meta.url),"utf8").split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean);
  for (const statement of statements) {
    let match: RegExpExecArray | null;
    if ((match=/^ALTER TABLE `(messages|runs|threads)` ADD `(\w+)` /.exec(statement))) {
      const [rows]=await conn.query<RowDataPacket[]>("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",[match[1],match[2]]);
      if (!rows.length) await conn.query(statement);
    } else if ((match=/^ALTER TABLE `(messages|runs|threads)` ADD CONSTRAINT `(\w+)` UNIQUE/.exec(statement)) || (match=/^CREATE INDEX `(\w+)` ON `(messages|runs|threads)` /.exec(statement))) {
      const constraint=statement.startsWith("ALTER");
      const table=match[constraint?1:2], name=match[constraint?2:1];
      const [rows]=await conn.query<RowDataPacket[]>("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?",[table,name]);
      if (!rows.length) await conn.query(statement);
    } else throw new ForgeError("SYS-9001",{message:"016迁移包含未批准DDL"});
  }
  const expected:unknown=JSON.parse(readFileSync(new URL("./run-thread-shape.json",import.meta.url),"utf8"));
  if(JSON.stringify(await runThreadShape(conn))!==JSON.stringify(expected))throw new ForgeError("SYS-9001",{message:"016运行会话结构与已审查迁移不符"});
}
