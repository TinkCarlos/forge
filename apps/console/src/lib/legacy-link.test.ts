import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { LEGACY_LINK_ATTRS, LEGACY_LINK_HINT, openLegacy, legacyRunHref } from './legacy-link'

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('K-32 未迁移页在新标签页打开旧版', () => {
  it('链接属性是 _blank + noopener noreferrer，并有中文提示', () => {
    expect(LEGACY_LINK_ATTRS).toEqual({ target: '_blank', rel: 'noopener noreferrer' })
    expect(LEGACY_LINK_HINT).toMatch(/新标签页/)
  })

  it('openLegacy 用 noopener,noreferrer 打开新窗口', () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    openLegacy('/#models')
    expect(open).toHaveBeenCalledWith('/#models', '_blank', 'noopener,noreferrer')
    vi.unstubAllGlobals()
  })

  it('侧栏外链和 ⌘K 都走这套属性，不再在当前标签跳走', () => {
    const nav = src('../components/layout/nav-group.tsx')
    expect(nav).toMatch(/\{\.\.\.LEGACY_LINK_ATTRS\}/)
    const cmd = src('../components/command-menu.tsx')
    expect(cmd).not.toMatch(/location\.assign/)
    expect(cmd).toMatch(/openLegacy\(/)
  })

  it('列表、空态和账号菜单的旧版入口也保留当前标签页', () => {
    for (const file of ['../features/agents/index.tsx', '../features/approvals/index.tsx', '../components/layout/nav-user.tsx']) {
      const links = src(file).match(/<a\b[^>]*href=(?:'\/(?:#[^']*)?'|\{legacyAgentHref\(a\.id\)\}|\{legacyRunHref\([^)]*\)\})[^>]*>/g) ?? []
      expect(links.length).toBeGreaterThan(0)
      for (const link of links) {
        expect(link, file).toContain('{...LEGACY_LINK_ATTRS}')
        expect(link, file).toContain('title={LEGACY_LINK_HINT}')
      }
    }
  })
})

describe('K-33 新版 Agent 行跳旧版详情', () => {
  it('审批跳到具体Run；非法ID不能进入详情路径', () => {
    expect(legacyRunHref('01J00000000000000000000006')).toBe('/#runs/01J00000000000000000000006')
    expect(legacyRunHref('../users')).toBe('/#runs')
    expect(src('../features/approvals/index.tsx')).toContain('href={legacyRunHref(a.run_id)}')
  })
  it('legacyAgentHref 生成 /#agents/<id>，id 不合法时只到列表', async () => {
    const mod = (await import('./legacy-link')) as Record<string, unknown>
    expect(mod.legacyAgentHref).toBeTypeOf('function')
    const href = mod.legacyAgentHref as (id: string) => string
    expect(href('agt_01M5PK6G1GPZ3APBN3QNXR')).toBe('/#agents/agt_01M5PK6G1GPZ3APBN3QNXR')
    expect(href('01J00000000000000000000006')).toBe('/#agents/01J00000000000000000000006')
    // 不合法的 id 只链到列表（旧版也会拒绝）
    expect(href('ag 中/1')).toBe('/#agents')
    expect(href('../users')).toBe('/#agents')
  })

  it('Agents 列表的「在旧版中查看详情」用该 Agent 的 id，不再是 /#agents', () => {
    const page = src('../features/agents/index.tsx')
    const item = page.match(/<a href=\{?[^>]*>\s*<ExternalLink \/> 在旧版中查看详情/)?.[0] ?? ''
    expect(item).toMatch(/legacyAgentHref\(a\.id\)/)
  })
})
