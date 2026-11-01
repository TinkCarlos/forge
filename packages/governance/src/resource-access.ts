import type { PoolConnection } from "mysql2/promise";
import { errors, readAuthorization, type DataScope, type Principal, type QueryFilter, type QueryScope } from "@forge/core";
import { repos, resourcePolicies, prospectiveConfigAllowed } from "@forge/store";
import { toPrincipal } from "@forge/identity";
import { assertPermission } from "./access.js";

export async function currentResourcePrincipal(principal: Principal, connection?: PoolConnection): Promise<{ principal: Principal; roles: string[] }> {
  if (principal.type === "app") throw errors.forbidden("管理配置需要用户或服务账号身份");
  const row = principal.type === "user" ? await repos.getActiveUserById(principal.id, connection) : await repos.getActiveServiceAccountById(principal.id, connection);
  if (!row || (principal.revision !== undefined && row.revision !== principal.revision)) throw errors.unauthorized();
  const auth = readAuthorization(row.authorization_json);
  if (!["all", "org", "self", "app"].includes(row.data_scope)) throw errors.forbidden("数据范围无效");
  const current: Principal = principal.type === "user" ? toPrincipal(row as Parameters<typeof toPrincipal>[0]) : { ...principal, role: row.role, orgUnitId: row.org_unit_id, dataScope: row.data_scope as DataScope, permissions: auth.permissions };
  return { principal: current, roles: auth.roles.filter(role => role.status === "active").map(role => role.key) };
}
export async function resourceFilterFor(principal: Principal, resource: string, action: string, connection?: PoolConnection): Promise<QueryFilter> {
  const { principal: live, roles } = await currentResourcePrincipal(principal, connection);
  let orgs: string[] | undefined;
  const scope = async (type: string, deny: boolean): Promise<QueryScope> => {
    switch (type) {
      case "all": return { type: "all" };
      case "self": return { type: "self", subjectType: live.type, subjectId: live.id };
      case "org": return { type: "orgs", ids: live.orgUnitId ? [live.orgUnitId] : [] };
      case "org_tree": return { type: "orgs", ids: orgs ??= await repos.orgSubtreeIds(live.orgUnitId, connection) };
      default: return deny ? { type: "all" } : { type: "resources", ids: [] };
    }
  };
  const policies = await resourcePolicies(roles, resource, connection), allow: QueryScope[] = [], deny: QueryScope[] = [];
  if (roles.includes("platform_admin")) allow.push({ type: "all" });
  for (const policy of policies) {
    if (policy.effect!=="allow" && policy.effect!=="deny") { deny.push({type:"all"}); continue; }
    if (!Array.isArray(policy.actions_json) || !policy.actions_json.some(value => value === action || value === "*")) continue;
    (policy.effect === "deny" ? deny : allow).push(await scope(policy.scope_type, policy.effect === "deny"));
  }
  // The request's verified ceiling and the live local ceiling both constrain the effective allow set.
  const local = await scope(live.dataScope === "org" ? "org_tree" : live.dataScope, false);
  const external = await scope(principal.dataScope === "org" ? "org_tree" : principal.dataScope, false);
  return { allow, deny, ceiling: { type: "intersection", scopes: [local, external] } };
}
export async function assertConfigCreate(principal: Principal, permission: string, resource: string, org: string | null, connection?: PoolConnection): Promise<void> {
  const { principal: live } = await currentResourcePrincipal(principal, connection);
  assertPermission(live, permission);
  if (org && !await repos.getActiveOrgUnit(org, connection)) throw errors.invalid("组织不存在或已停用");
  const filter = await resourceFilterFor(principal, resource, "manage", connection);
  if (!await prospectiveConfigAllowed(filter, org, live.type === "user" ? live.id : null, connection)) throw errors.forbidden("无权在此范围创建配置");
}
