import type { PoolConnection } from "mysql2/promise";
import type { QueryFilter } from "@forge/core";
import { query, one } from "../db.js";
import { jobFilterSql } from "../job-filter.js";
export interface ResourcePolicyRow { scope_type: string; effect: "allow" | "deny"; actions_json: string[] }
export async function resourcePolicies(roleKeys: string[], resource: string, connection?: PoolConnection): Promise<ResourcePolicyRow[]> {
  if (!roleKeys.length) return [];
  return query<ResourcePolicyRow>(`SELECT scope_type,effect,actions_json FROM data_policies WHERE role IN (${roleKeys.map(() => "?").join(",")}) AND resource_type IN (?,'*')`, [...roleKeys, resource], connection);
}
export async function prospectiveConfigAllowed(filter: QueryFilter, org: string | null, createdBy: string | null, connection?: PoolConnection): Promise<boolean> {
  const access = jobFilterSql(filter, "definition");
  return Boolean(await one(`SELECT 1 AS allowed FROM (SELECT NULL AS id,? AS owner_org_unit_id,? AS created_by) d WHERE ${access.sql}`, [org, createdBy, ...access.params], connection));
}

export interface AgentJobTargetRow { id: string; key: string; name: string; owner_org_unit_id: string | null; version_id: string; instructions: string; spec_json: Record<string, unknown> }
export async function agentJobTargets(filter: QueryFilter, connection?: PoolConnection): Promise<AgentJobTargetRow[]> {
  const access = jobFilterSql(filter, "definition");
  return query<AgentJobTargetRow>(`SELECT d.id,d.key,d.name,d.owner_org_unit_id,v.id AS version_id,v.instructions,v.spec_json FROM agents d JOIN agent_versions v ON v.id=d.published_version_id AND v.agent_id=d.id WHERE d.status='active' AND d.deleted_at IS NULL AND v.status='published' AND ${access.sql} ORDER BY d.created_at DESC,d.id DESC`, access.params, connection);
}

export async function messageRuleSourceOwner(type:"job"|"agent"|"api_app",id:string,filter:QueryFilter,connection:PoolConnection):Promise<{owner_org_unit_id:string|null}|null>{
 const table={job:"job_definitions",agent:"agents",api_app:"api_apps"}[type],access=jobFilterSql(filter,"definition");
 return one(`SELECT d.owner_org_unit_id FROM ${table} d WHERE d.id=? AND ${type==="agent"?"d.deleted_at IS NULL":"d.status<>'deleted'"} AND ${access.sql}`,[id,...access.params],connection);
}
