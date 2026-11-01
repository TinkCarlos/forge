import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { sha256 } from "@forge/core";
import { query } from "./db.js";

export interface SsoRoleSnapshot {
  mappings:Array<{id:string;revision:number;agent_role_code:string;agent_role_name:string;local_role:string}>;
  roles:Array<{id:string;key:string;status:string;revision:number}>;
  revision:string;
}
/** Used outside the lock for selection, then compared under the account lock before a first-time grant. */
export async function ssoRoleSnapshot(conn?:PoolConnection):Promise<SsoRoleSnapshot> {
  const read=async(sql:string)=>conn ? (await conn.query<RowDataPacket[]>(sql))[0] : query<Record<string,unknown>>(sql);
  const mappings=await read("SELECT id,revision,agent_role_code,agent_role_name,local_role FROM oidc_role_mappings ORDER BY id") as SsoRoleSnapshot["mappings"];
  const roles=await read("SELECT id,`key`,status,revision FROM roles ORDER BY id") as SsoRoleSnapshot["roles"];
  return {mappings,roles,revision:sha256(JSON.stringify([mappings,roles]))};
}
