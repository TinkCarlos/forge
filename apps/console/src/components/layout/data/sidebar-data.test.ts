import { Shield } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { filterNavGroups, LEGACY_PAGE_PERMISSIONS, ROUTE_PERMISSIONS } from '../../../lib/permissions'
import { type NavLink } from '../types'
import { page, sidebarData } from './sidebar-data'

const items = sidebarData.navGroups.flatMap((g) => g.items) as NavLink[]
const ORG_ADMIN_AFTER_C = ['agent.view', 'agent.manage', 'agent.publish', 'agent.run', 'approval.view', 'approval.decide', 'apikey.view', 'apikey.manage', 'user.view', 'run.view']

describe('侧栏权限规则（K-29）', () => {
  it('每个入口都配了权限', () => {
    for (const i of items) expect(Boolean(i.permission) || Boolean(i.anyPermissions?.length), i.title).toBe(true)
  })
  it('账号与权限支持任一获准页签，仍拒绝没有两种读取权限的用户', () => {
    const visible = (perms: string[]) => filterNavGroups(sidebarData.navGroups, perms).flatMap(group => group.items).some(item => item.url === '/#users')
    expect(visible(['role.view'])).toBe(true); expect(visible(['user.view'])).toBe(true); expect(visible(['role.manage'])).toBe(false); expect(visible([])).toBe(false)
  })
  it('新版页面入口的权限与路由守卫一致' , () => {
    for (const i of items.filter((x) => !x.external)) expect(i.permission).toBe(ROUTE_PERMISSIONS[i.url as keyof typeof ROUTE_PERMISSIONS])
  })
  it('旧版入口的权限取自 LEGACY_PAGE_PERMISSIONS', () => {
    for (const i of items.filter((x) => x.external)) {
      const id = String(i.url).replace('/#', '') as keyof typeof LEGACY_PAGE_PERMISSIONS
      if (id === 'users') expect(i.anyPermissions).toEqual(['user.view', 'role.view'])
      else expect(i.permission, i.title).toBe(LEGACY_PAGE_PERMISSIONS[id])
    }
  })
  it('审计入口（新版 /audit 和旧版 #audit）都要求 audit.view', () => {
    expect(ROUTE_PERMISSIONS['/audit']).toBe('audit.view')
    expect(LEGACY_PAGE_PERMISSIONS.audit).toBe('audit.view')
    expect(page('/audit', '审计', Shield).permission).toBe('audit.view')
  })
  it('以后加上审计入口时：没有 audit.view 的角色看不到，有的能看到', () => {
    const groups = [...sidebarData.navGroups, { title: '治理', items: [page('/audit', '审计', Shield)] }]
    const titles = (perms: string[]) => filterNavGroups(groups, perms).flatMap((g) => g.items.map((i) => i.title))
    expect(titles(ORG_ADMIN_AFTER_C)).not.toContain('审计')
    expect(titles(['run.view', 'audit.view', 'usage.view', 'agent.view'])).toContain('审计')
    expect(titles(['*'])).toContain('审计')
  })
})
