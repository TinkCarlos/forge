import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { LEGACY_LINK_ATTRS, LEGACY_LINK_HINT, openLegacy } from './legacy-link'

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
})
