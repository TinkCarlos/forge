import { errors, hasPermission, type Principal } from "@forge/core";
import { repos, type RunRow } from "@forge/store";
import { auditScopeFromGrants, scopeCoversOrg, type AuditGrant, type AuditScope } from "./audit-scope.js";

export function assertPermission(principal: Principal, permission: string): void {
  if (principal.type === "app") {
    const scopes = principal.scopes ?? [];
    if (!scopes.includes(permission) && !scopes.includes("*")) throw errors.forbidden(`应用缺少 Scope: ${permission}`);
    return;
  }
  if (!hasPermission(principal.role, permission)) throw errors.forbidden(`角色缺少权限: ${permission}`);
}

/**
 * Effective scopes of an API-key request (P2, architect on e2d2c5f): the Key's scopes ∩ the app's *current* scopes.
 * Narrowing the app takes effect on the next request; widening it never widens an existing Key. No `*` handling here
 * (assertScope never treats `*` as a wildcard).
 */
export function effectiveKeyScopes(keyScopes: readonly string[], appScopes: readonly string[]): string[] {
  const allowed = new Set(appScopes);
  return keyScopes.filter((scope) => allowed.has(scope));
}

export function assertScope(principal: Principal, scope: string): void {
  if (principal.type === "app" && !(principal.scopes ?? []).includes(scope)) {
    throw errors.forbidden(`应用缺少 Scope: ${scope}`);
  }
}

export interface RunFilter {
  orgIds?: string[] | null;
  subjectType?: string;
  subjectId?: string;
  appId?: string;
}

export async function runFilterFor(principal: Principal): Promise<RunFilter> {
  if (principal.type === "app") return { appId: principal.appId };
  if (principal.dataScope === "all") return {};
  if (principal.dataScope === "self") return { subjectType: "user", subjectId: principal.id };
  const orgIds = await repos.orgSubtreeIds(principal.orgUnitId);
  return { orgIds };
}

export async function canAccessRun(principal: Principal, run: RunRow): Promise<boolean> {
  if (principal.type === "app") return run.app_id === principal.appId;
  if (principal.dataScope === "all") return true;
  if (principal.dataScope === "self") return run.subject_type === "user" && run.subject_id === principal.id;
  if (!principal.orgUnitId || !run.org_unit_id) return false;
  const orgIds = await repos.orgSubtreeIds(principal.orgUnitId);
  return orgIds.includes(run.org_unit_id);
}

export async function assertRunAccess(principal: Principal, run: RunRow | null): Promise<void> {
  if (!run) throw errors.notFound("Run 不存在");
  if (!(await canAccessRun(principal, run))) throw errors.notFound("Run 不存在");
}

/**
 * Department scope for org-owned admin resources (schedules, service accounts), same rule as {@link canAccessRun} for org:
 * dataScope all -> null (everything); otherwise the caller's department plus all of its sub-departments ([] without one).
 */
export async function orgScopeIds(principal: Principal): Promise<string[] | null> {
  if (principal.dataScope === "all") return null;
  return repos.orgSubtreeIds(principal.orgUnitId);
}

export function inOrgScope(scopeIds: string[] | null, orgUnitId: unknown): boolean {
  if (scopeIds === null) return true;
  return typeof orgUnitId === "string" && scopeIds.includes(orgUnitId);
}

export async function visibleAgentOrgIds(principal: Principal): Promise<string[] | null> {
  if (principal.type === "app" || principal.dataScope === "all") return null;
  if (!principal.orgUnitId) return [];
  return repos.orgSubtreeIds(principal.orgUnitId);
}

/**
 * I-SCOPE-13/14: audit rows the principal may read. The Principal carries one dataScope today ("all" | "org" | "self" |
 * "app"); it is mapped to grants and evaluated by the generic rules in auditScopeFromGrants (union, all absorbs).
 * "org" is the org_tree scope (same subtree rule as canAccessRun). custom_orgs has no Principal field yet.
 */
export async function dataScopeFor(principal: Principal): Promise<AuditScope> {
  const grants: AuditGrant[] = [];
  if (principal.dataScope === "all") grants.push({ scope: "all" });
  else if (principal.dataScope === "org") grants.push({ scope: "org_tree" });
  else if (principal.dataScope === "self") grants.push({ scope: "self" });
  else if (principal.dataScope === "app") grants.push({ scope: "app" });
  return auditScopeFromGrants({ type: principal.type, id: principal.id, orgUnitId: principal.orgUnitId }, grants, (orgId) => repos.orgSubtreeIds(orgId));
}

/** Audit read filter (plan A ruling ④): the principal's data scope. */
export const auditFilterFor = dataScopeFor;

/**
 * K-05 / P0-02: a write to a department-owned resource outside the caller's data scope -> 403 POL-2001, thrown
 * before anything is written. Same scope as auditFilterFor (dataScopeFor + scopeCoversOrg), not a second rule set.
 * 403 (not 404) because the resources this guards (api apps, keys, webhook deliveries) are globally readable.
 */
export async function assertOrgWritable(principal: Principal, orgUnitId: string | null | undefined, message = "无权修改本部门数据范围以外的资源"): Promise<void> {
  if (!scopeCoversOrg(await dataScopeFor(principal), orgUnitId)) throw errors.forbidden(message);
}

export { auditScopeFromGrants, scopeCoversOrg, type AuditGrant, type AuditScope, type AuditSubject } from "./audit-scope.js";
export { buildArgsPreview, isHttpUrl, isSecretValue, isSensitiveKey, keySegments, looksLikeJson, looksLikeUrl, maskQueryString, maskUrlQuery, SENSITIVE_KEY_SEGMENTS, SENSITIVE_QUERY_PARAMS, ARGS_PREVIEW_VALUE_MAX, ARGS_PREVIEW_TOTAL_MAX } from "./args-preview.js";
export { assertCanGrant, assertCanManageUser, canSeeUser, grantDefaultDataScope, loadVisibleUserOr404, userFilterFor, USER_DATA_SCOPES } from "./user-admin.js";
export { maskArgsDeep, MASK_ARGS_MAX_DEPTH } from "./mask-args.js";
export { maskProseSecrets } from "./sensitive.js";
