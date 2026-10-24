import { describe, expect, it } from 'vitest'
import { sidebarData } from '../components/layout/data/sidebar-data'
import { ApiError } from './api'
import { dialogErrorOutcome } from './dialog-error'
import { ForbiddenError, LEGACY_PAGE_PERMISSIONS, ROUTE_PERMISSIONS, assertCan, createGuard, filterNavGroups, isForbidden } from './permissions'

// K-17：执行表 #12 #13 #15 #37 #38 #39 #85「缺权限 → 403」在前端的自动化覆盖。
// 内置角色都有 agent.view / run.view，所以用自定义权限集模拟「缺这一项」的主体。
// 后端真正返回 403 的覆盖仍需后端用自定义角色或测试主体补（见报告）；#85 走 Connector JWT，前端不涉及。
const ALL = ['agent.view', 'agent.manage', 'agent.publish', 'approval.view', 'approval.decide', 'run.view', 'schedule.view', 'user.view']
const without = (p: string) => ALL.filter((x) => x !== p)
const titles = (perms: string[]) => filterNavGroups(sidebarData.navGroups, perms).flatMap((g) => g.items.map((i) => i.title))
const backend403 = (perm: string) => new ApiError(`角色缺少权限: ${perm}`, 403, 'AUTH-1003')

describe.each([
  { row: '#12', api: 'GET /admin/api/dashboard', perm: 'agent.view', nav: '总览' },
  { row: '#13', api: 'GET /admin/api/agents', perm: 'agent.view', nav: 'Agents' },
  { row: '#15', api: 'GET /admin/api/agents/:id', perm: 'agent.view', nav: 'Agents' },
  { row: '#37', api: 'GET /admin/api/runs', perm: 'run.view', nav: '运行中心' },
  { row: '#38', api: 'GET /admin/api/runs/:id', perm: 'run.view', nav: '运行中心' },
  { row: '#39', api: 'GET /admin/api/runs/:id/events', perm: 'run.view', nav: '运行中心' },
])('K-17 $row $api 缺 $perm', ({ perm, nav }) => {
  it('入口对缺权限的主体隐藏，有权限时可见', () => {
    expect(titles(without(perm))).not.toContain(nav)
    expect(titles(ALL)).toContain(nav)
  })
  it('后端 403 被前端识别为权限错误（列表显示「没有权限查看」，确认框关闭）', () => {
    expect(isForbidden(backend403(perm))).toBe(true)
    expect(dialogErrorOutcome(backend403(perm))).toBe('forbidden')
  })
})

describe('K-17 新版路由守卫', () => {
  it('#13 /agents 缺 agent.view → 403', () => {
    const guard = createGuard(() => ({ permissions: without('agent.view') }))
    expect(() => guard(ROUTE_PERMISSIONS['/agents'])()).toThrow(ForbiddenError)
  })
  it('旧版页面的权限映射与执行表一致', () => {
    expect(LEGACY_PAGE_PERMISSIONS.dashboard).toBe('agent.view')
    expect(LEGACY_PAGE_PERMISSIONS.runs).toBe('run.view')
    expect(() => assertCan(without('run.view'), 'run.view')).toThrow(ForbiddenError)
  })
})
