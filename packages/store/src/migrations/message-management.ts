import {readFileSync} from "node:fs";
import type {Connection,RowDataPacket} from "mysql2/promise";
import {ForgeError} from "@forge/core/errors";
import {reviewedSchemaShape} from "./job-core.js";
export const MESSAGE_TABLES=["message_channels","message_channel_versions","message_templates","message_template_versions","message_rules","message_deliveries","message_delivery_attempts"] as const;
export const messageManagementShape=(conn:Pick<Connection,"query">)=>reviewedSchemaShape(conn,MESSAGE_TABLES);
export async function applyMessageManagement(conn:Pick<Connection,"query">):Promise<void>{
 const statements=readFileSync(new URL("../../drizzle/0006_message_management_expand.sql",import.meta.url),"utf8").split("--> statement-breakpoint").map(sql=>sql.trim()).filter(Boolean);
 for(const statement of statements){let match:RegExpExecArray|null;
  if((match=/^CREATE TABLE `(\w+)` \(/.exec(statement))&&(MESSAGE_TABLES as readonly string[]).includes(match[1]!))await conn.query(statement.replace("CREATE TABLE","CREATE TABLE IF NOT EXISTS"));
  else if((match=/^ALTER TABLE `(\w+)` ADD CONSTRAINT `(\w+)` FOREIGN KEY/.exec(statement))&&(MESSAGE_TABLES as readonly string[]).includes(match[1]!)){const[rows]=await conn.query<RowDataPacket[]>("SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=?",[match[1],match[2]]);if(!rows.length)await conn.query(statement);}
  else if((match=/^CREATE INDEX `(\w+)` ON `(\w+)` /.exec(statement))&&(MESSAGE_TABLES as readonly string[]).includes(match[2]!)){const[rows]=await conn.query<RowDataPacket[]>("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?",[match[2],match[1]]);if(!rows.length)await conn.query(statement);}
  else throw new ForgeError("SYS-9001",{message:"015迁移包含未批准DDL"});
 }
 const expected:unknown=JSON.parse(readFileSync(new URL("./message-management-shape.json",import.meta.url),"utf8"));
 if(JSON.stringify(await messageManagementShape(conn))!==JSON.stringify(expected))throw new ForgeError("SYS-9001",{message:"015消息结构与已审查迁移不符"});
}
