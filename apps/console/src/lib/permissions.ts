/**
 * K-29：控制台权限判断集中在这里。
 * 数据来自 /auth/session 的 permissions（platform_admin 是 ["*"]）。前端只做「隐藏入口 / 显示 403」，
 * 真正的鉴权仍在后端，所以这里宁可隐藏多了，也不要显示一个点了必定 403 的按钮。
 * 本文件不依赖 React、路由和 '@/' 别名，方便直接单测。
 */

export type Permission =
  | 'agent.view'
  | 'agent.manage'
  | 'agent.publish'
  | 'agent.run'
  | 'approval.view'
  | 'approval.decide'
  | 'apikey.view'
  | 'apikey.manage'
  | 'audit.view'
  | 'model.view'
  | 'mcp.view'
  | 'skill.view'
  | 'tool.view'
  | 'package.view'
  | 'run.view'
  | 'schedule.view'
  | 'user.view'
  | 'sso.manage'
  | (string & {})

/** 从 /auth/session 的返回里取权限列表；字段缺失或格式不对时当作「没有任何权限」。 */
export function permissionsOf(session: unknown): string[] {
  const list = (session as { permissions?: unknown } | null | undefined)?.permissions
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
}

/** 传数组表示「全部都要有」。 */
export function can(perms: readonly string[] | null | undefined, need: Permission | readonly Permission[]): boolean {
  if (!perms || perms.length === 0) return false
  if (perms.includes('*')) return true
  const all = typeof need === 'string' ? [need] : need
  return all.every((p) => perms.includes(p))
}

export class ForbiddenError extends Error {
  readonly status = 403
  constructor(readonly permission: Permission) {
    super(`缺少权限 ${permission}`)
    this.name = 'ForbiddenError'
  }
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ForbiddenError || (typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 403)
}

/** 路由守卫：没有权限就抛 ForbiddenError，由该路由的 errorComponent 渲染 403 页。 */
export function assertCan(perms: readonly string[] | null | undefined, need: Permission): void {
  if (!can(perms, need)) throw new ForbiddenError(need)
}

/** 守卫工厂：getSession 注入，便于单测；生产用法见 route-guard.ts。 */
export function createGuard(getSession: () => unknown) {
  return (need: Permission) => () => assertCan(permissionsOf(getSession()), need)
}

/**
 * 新版控制台页面要求的权限。加新页面时在这里登记，路由文件用 guard()、侧栏用 permission 引用同一个值。
 * '/audit' 目前还没有页面，先把规则定下来：审计只看 audit.view（后端方案 C 会去掉 OA 的 audit.view）。
 */
export const ROUTE_PERMISSIONS = {
  '/agents': 'agent.view',
  '/approvals': 'approval.view',
  '/audit': 'audit.view',
} as const satisfies Record<string, Permission>

/** 侧栏里跳旧版控制台（/#<id>）的入口要求的权限，取自该页面列表接口在后端（apps/api/src/routes/admin/*）要求的权限。 */
export const LEGACY_PAGE_PERMISSIONS = {
  dashboard: 'agent.view',
  models: 'model.view',
  mcp: 'mcp.view',
  skills: 'skill.view',
  tools: 'tool.view',
  packages: 'package.view',
  runs: 'run.view',
  schedules: 'schedule.view',
  apps: 'apikey.view',
  users: 'user.view',
  sso: 'sso.manage',
  audit: 'audit.view',
} as const satisfies Record<string, Permission>

/** 侧栏过滤：去掉没权限的入口，再去掉因此变空的分组。 */
export function filterNavGroups<G extends { items: readonly { permission?: Permission }[] }>(
  groups: readonly G[],
  perms: readonly string[] | null | undefined
): G[] {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.permission || can(perms, i.permission)) }) as G)
    .filter((g) => g.items.length > 0)
}

/** 403 页「返回」：有站内历史就回上一页，否则回 Agents。 */
export const FORBIDDEN_FALLBACK = '/agents' as const
export function backTarget(canGoBack: boolean): 'history' | typeof FORBIDDEN_FALLBACK {
  return canGoBack ? 'history' : FORBIDDEN_FALLBACK
}
