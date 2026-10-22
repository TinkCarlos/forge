import { errors, hasPermission, type Principal } from "@forge/core";
import { repos, type RunRow } from "@forge/store";

export function assertPermission(principal: Principal, permission: string): void {
  if (principal.type === "app") {
    const scopes = principal.scopes ?? [];
    if (!scopes.includes(permission) && !scopes.includes("*")) throw errors.forbidden(`应用缺少 Scope: ${permission}`);
    return;
  }
  if (!hasPermission(principal.role, permission)) throw errors.forbidden(`角色缺少权限: ${permission}`);
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

export async function visibleAgentOrgIds(principal: Principal): Promise<string[] | null> {
  if (principal.type === "app" || principal.dataScope === "all") return null;
  if (!principal.orgUnitId) return [];
  return repos.orgSubtreeIds(principal.orgUnitId);
}

export { buildArgsPreview, isHttpUrl, isSecretValue, isSensitiveKey, keySegments, looksLikeUrl, maskQueryString, maskUrlQuery, SENSITIVE_KEY_SEGMENTS, SENSITIVE_QUERY_PARAMS, ARGS_PREVIEW_VALUE_MAX, ARGS_PREVIEW_TOTAL_MAX } from "./args-preview.js";
