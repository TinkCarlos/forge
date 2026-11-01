import { defaultDataScope, errors, permissionsFor, readAuthorization, type DataScope, type Principal, type Role } from "@forge/core";
import { repos, type UserFilter, type UserRow, type RoleRow, type ReadConnection } from "@forge/store";

// User administration rules (AGENTS.md 5.3, permissions.md): a non-platform_admin manages only users inside its own
// data scope, never grants a wider dataScope or a role with permissions it does not have, and never touches a
// platform_admin. platform_admin is unrestricted.

/** dataScope values a user row may hold. */
export const USER_DATA_SCOPES: readonly DataScope[] = ["all", "org", "self"];
const SCOPE_RANK: Record<string, number> = { self: 0, org: 1, all: 2 };
/** Roles only a platform_admin may grant (unchanged from before: POL-2001 "不能授予该角色"). */
const PLATFORM_ONLY_ROLES = ["platform_admin", "org_admin"];

const isPlatformAdmin = (principal: Principal): boolean => principal.role === "platform_admin";
const scopeRank = (scope: string): number => SCOPE_RANK[scope] ?? -1;

/** SQL filter for the users the principal can see: platform_admin / dataScope all -> everyone; org -> own org subtree; self -> only itself. */
export async function userFilterFor(principal: Principal, connection?: ReadConnection): Promise<UserFilter> {
  if (isPlatformAdmin(principal) || principal.dataScope === "all") return {};
  if (principal.dataScope === "org") return { orgIds: await repos.orgSubtreeIds(principal.orgUnitId, connection) };
  return { userId: principal.id };
}

export async function canSeeUser(principal: Principal, user: UserRow, connection?: ReadConnection): Promise<boolean> {
  const filter = await userFilterFor(principal, connection);
  if (filter.userId !== undefined) return user.id === filter.userId;
  if (filter.orgIds) return user.org_unit_id !== null && filter.orgIds.includes(user.org_unit_id);
  return true;
}

/** Loads a user through the list data scope: invisible and nonexistent both -> the same 404. */
export async function loadVisibleUserOr404(principal: Principal, id: string): Promise<UserRow> {
  const user = id ? await repos.getUserById(id) : null;
  if (!user || user.status === "deleted" || !(await canSeeUser(principal, user))) throw errors.notFound("用户不存在");
  return user;
}

/** Only a platform_admin may modify a platform_admin (role, dataScope or status). */
export function assertCanManageUser(principal: Principal, target: UserRow): void {
  if (!isPlatformAdmin(principal) && target.role === "platform_admin") throw errors.forbidden("不能修改 platform_admin");
  if (!isPlatformAdmin(principal)) {
    if (PLATFORM_ONLY_ROLES.includes(target.role) || readAuthorization(target.authorization_json).roles.some(role=>PLATFORM_ONLY_ROLES.includes(role.key))) throw errors.forbidden("不能管理该角色账号");
    assertPermissionCeiling(principal,readAuthorization(target.authorization_json).grantedPermissions);
    if(scopeRank(target.data_scope)>scopeRank(principal.dataScope)) throw errors.forbidden("不能管理超出自身的数据范围");
  }
}

/** Default dataScope for a granted role; for a non-platform_admin it is capped at the caller's own scope (auditor defaults to all). */
export function grantDefaultDataScope(principal: Principal, role: Role): DataScope {
  const fallback = defaultDataScope(role);
  if (isPlatformAdmin(principal) || scopeRank(fallback) <= scopeRank(principal.dataScope)) return fallback;
  return principal.dataScope;
}

/**
 * role must be a built-in role and dataScope one of all/org/self (400 otherwise).
 * A non-platform_admin cannot grant platform_admin/org_admin or any role with a permission it lacks,
 * and cannot grant a dataScope wider than its own (403 POL-2001).
 */
export function assertCanGrant(principal: Principal, role: string, dataScope: string, roles: readonly RoleRow[]): void {
  if (!roles.some(row=>row.key===role)) throw errors.invalid("非法角色");
  if (!USER_DATA_SCOPES.includes(dataScope as DataScope)) throw errors.invalid("非法数据范围（只能是 all、org、self）");
  if (isPlatformAdmin(principal)) return;
  if (roles.some(row=>PLATFORM_ONLY_ROLES.includes(row.key))) {
    throw errors.forbidden("不能授予该角色");
  }
  assertPermissionCeiling(principal,roles.flatMap(row=>row.permissions_json));
  if (scopeRank(dataScope) > scopeRank(principal.dataScope)) throw errors.forbidden("不能授予超出自身的数据范围");
}

export function assertPermissionCeiling(principal: Principal, granted: readonly string[]): void {
  const own = permissionsFor(principal);
  if (!granted.every(permission=>own.includes("*")||own.includes(permission))) throw errors.forbidden("不能授予或管理超出自身的功能权限");
}
