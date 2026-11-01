import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const renderNavSource = source.match(/^function renderNav\([\s\S]*?^\}/m)![0]

function harness(fromNav: boolean, visible = true) {
  const selected = { focus: vi.fn(), scrollIntoView: vi.fn() }
  const nav = { innerHTML: '', contains: () => fromNav, querySelector: () => visible ? selected : null }
  const render = new Function('$', 'document', 'state', 'navGroups', 'navAllowed', `${renderNavSource}; return renderNav`)(
    () => nav, { activeElement: {} }, { tab: 'agents' },
    [{ label: '构建', items: [{ id: 'agents', label: 'Agents', icon: 'A' }] }], () => visible
  ) as () => void
  return { selected, nav, render }
}

describe('旧版导航重绘', () => {
  it('键盘切换后保留焦点，并让当前项在横向或纵向导航内可见', () => {
    const h = harness(true)
    h.render()
    expect(h.selected.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(h.selected.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(h.nav.innerHTML).toContain('aria-current="page"')
    expect(h.nav.innerHTML).toContain('aria-hidden="true"')
  })

  it('从内容区或深链接进入时不抢焦点，无可见入口时安全返回', () => {
    const h = harness(false)
    h.render()
    expect(h.selected.focus).not.toHaveBeenCalled()
    const hidden = harness(true, false)
    expect(() => hidden.render()).not.toThrow()
    expect(hidden.selected.focus).not.toHaveBeenCalled()
  })
})
