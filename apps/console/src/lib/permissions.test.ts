import { describe, expect, it } from 'vitest'
import {
  assertCan,
  backTarget,
  can,
  createGuard,
  filterNavGroups,
  ForbiddenError,
  isForbidden,
  permissionsOf,
  ROUTE_PERMISSIONS,
} from './permissions'

// 与后端 packages/core ROLE_PERMISSIONS（b0f8ddd）中和控制台相关的部分保持一致
const ROLES: Record<string, string[]> = {
  platform_admin: ['*'],
  org_admin: ['agent.view', 'agent.manage', 'agent.publish', 'agent.run', 'run.view', 'approval.view', 'approval.decide', 'apikey.view', 'apikey.manage', 'user.view', 'audit.view', 'model.view', 'mcp.view', 'skill.view', 'tool.view', 'schedule.view'],
  builder: ['agent.view', 'agent.manage', 'agent.publish', 'agent.run', 'run.view', 'model.view', 'mcp.view', 'skill.view', 'tool.view', 'schedule.view'],
  operator: ['agent.view', 'agent.run', 'run.view', 'run.cancel', 'approval.view', 'approval.decide', 'schedule.view', 'schedule.run'],
  auditor: ['run.view', 'audit.view', 'usage.view', 'agent.view'],
}

describe('permissionsOf', () => {
  it('取 /auth/session 的 permissions，只保留字符串', () => {
    expect(permissionsOf({ permissions: ['agent.view', 1, null, 'approval.view'] })).toEqual(['agent.view', 'approval.view'])
  })
  it('会话为空或字段缺失/格式不对时视为没有权限', () => {
    expect(permissionsOf(null)).toEqual([])
    expect(permissionsOf(undefined)).toEqual([])
    expect(permissionsOf({ user: { role: 'org_admin' } })).toEqual([])
    expect(permissionsOf({ permissions: 'agent.view' })).toEqual([])
  })
})

describe('can', () => {
  it('* 拥有全部权限', () => {
    expect(can(['*'], 'audit.view')).toBe(true)
    expect(can(['*'], ['agent.manage', 'sso.manage'])).toBe(true)
  })
  it('空列表、null 一律 false', () => {
    expect(can([], 'agent.view')).toBe(false)
    expect(can(null, 'agent.view')).toBe(false)
  })
  it('数组要求全部满足', () => {
    expect(can(ROLES.operator, ['approval.view', 'approval.decide'])).toBe(true)
    expect(can(ROLES.operator, ['agent.view', 'agent.manage'])).toBe(false)
  })
  it.each([
    ['org_admin', 'agent.manage', true],
    ['org_admin', 'apikey.manage', true],
    ['org_admin', 'audit.view', true],
    ['builder', 'agent.publish', true],
    ['builder', 'approval.view', false],
    ['builder', 'apikey.view', false],
    ['operator', 'agent.manage', false], // UI-042a：operator 看不到开放 API 入口
    ['operator', 'agent.publish', false],
    ['operator', 'approval.decide', true],
    ['auditor', 'approval.view', false],
    ['auditor', 'audit.view', true],
  ])('%s → %s = %s', (role, perm, expected) => {
    expect(can(ROLES[role], perm)).toBe(expected)
  })
  it('方案 C 之后 OA 去掉 audit.view 即不可见', () => {
    expect(can(ROLES.org_admin.filter((p) => p !== 'audit.view'), 'audit.view')).toBe(false)
  })
})

describe('路由守卫', () => {
  const guardFor = (session: unknown) => createGuard(() => session)

  it('有权限时放行', () => {
    expect(() => guardFor({ permissions: ROLES.operator })(ROUTE_PERMISSIONS['/approvals'])()).not.toThrow()
    expect(() => guardFor({ permissions: ['*'] })(ROUTE_PERMISSIONS['/approvals'])()).not.toThrow()
  })
  it('无权限时抛 ForbiddenError（403），带上缺的权限', () => {
    let caught: unknown
    try {
      guardFor({ permissions: ROLES.builder })(ROUTE_PERMISSIONS['/approvals'])()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ForbiddenError)
    expect((caught as ForbiddenError).permission).toBe('approval.view')
    expect((caught as ForbiddenError).status).toBe(403)
    expect(isForbidden(caught)).toBe(true)
  })
  it('每次执行时读最新会话（不缓存）', () => {
    let session: unknown = { permissions: [] }
    const g = createGuard(() => session)('agent.view')
    expect(g).toThrow(ForbiddenError)
    session = { permissions: ['agent.view'] }
    expect(g).not.toThrow()
  })
  it('会话缺失时也拒绝（不会默认放行）', () => {
    expect(guardFor(null)('agent.view')).toThrow(ForbiddenError)
  })
  it('所有角色都能进 /agents（默认落地页不会 403）', () => {
    for (const perms of Object.values(ROLES)) expect(() => assertCan(perms, ROUTE_PERMISSIONS['/agents'])).not.toThrow()
  })
  it('isForbidden 也识别接口返回的 403 ApiError，不误判其他错误', () => {
    expect(isForbidden({ status: 403, code: 'AUTH-1003' })).toBe(true)
    expect(isForbidden({ status: 401 })).toBe(false)
    expect(isForbidden(new Error('x'))).toBe(false)
    expect(isForbidden(null)).toBe(false)
  })
})

describe('filterNavGroups', () => {
  type Item = { title: string; permission?: string }
  const groups: { title: string; items: Item[] }[] = [
    { title: '构建', items: [{ title: 'Agents', permission: 'agent.view' }, { title: '模型', permission: 'model.view' }] },
    { title: '运行', items: [{ title: '审批中心', permission: 'approval.view' }] },
    { title: '治理', items: [{ title: '审计', permission: 'audit.view' }] },
    { title: '公开', items: [{ title: '帮助' }] },
  ]
  const titles = (perms: string[]) => filterNavGroups(groups, perms).flatMap((g) => g.items.map((i) => i.title))

  it('按权限隐藏入口，没有 permission 的入口始终显示', () => {
    expect(titles(ROLES.operator)).toEqual(['Agents', '审批中心', '帮助'])
    expect(titles(ROLES.auditor)).toEqual(['Agents', '审计', '帮助'])
    expect(titles(['*'])).toEqual(['Agents', '模型', '审批中心', '审计', '帮助'])
  })
  it('分组里的入口全被隐藏时整个分组不显示', () => {
    expect(filterNavGroups(groups, ROLES.builder).map((g) => g.title)).toEqual(['构建', '公开'])
  })
  it('不修改传入的数据', () => {
    filterNavGroups(groups, [])
    expect(groups[0].items).toHaveLength(2)
  })
})

describe('403 页「返回」', () => {
  it('有站内历史时回上一页', () => expect(backTarget(true)).toBe('history'))
  it('直接打开地址（无历史）时回 /agents', () => expect(backTarget(false)).toBe('/agents'))
})
