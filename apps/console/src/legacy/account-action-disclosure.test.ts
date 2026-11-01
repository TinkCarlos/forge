import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
function fn(name: string) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!match) throw new Error(`missing ${name}`)
  return match[0]
}

type KeyEvent = { key: string; preventDefault(): void; stopPropagation(): void }
function harness(manage = true, sso = true) {
  const events: string[] = []
  const summary = { focus: () => { events.push('summary:focus') } }
  const menu = {
    open: true,
    onkeydown: null as ((event: KeyEvent) => void) | null,
    querySelector: (selector: string) => selector === 'summary' ? summary : null,
  }
  const button = {
    dataset: { id: 'usr_target', userAction: 'edit' },
    closest: (selector: string) => selector === '.account-more' ? menu : null,
    onclick: null as (() => unknown) | null,
  }
  const content = {
    innerHTML: '',
    querySelectorAll: (selector: string) => selector === '[data-user-action]' ? [button] : selector === '.account-more' ? [menu] : [],
  }
  const form = { onsubmit: null }
  const state = {
    tab: 'users',
    session: { permissions: ['user.view', ...(sso ? ['sso.manage'] : [])], user: { role: 'platform_admin' } },
    userFilters: { q: '', status: '', cursor: '', history: [] },
  }
  const api = async () => ({
    items: [{ id: 'usr_target', username: '张三', display_name: '张三', email: 'a@example.com', role: 'user', data_scope: 'self', status: 'active', can_manage: manage }],
    grantableRoles: [], canCreate: false, nextCursor: null,
  })
  const deps = {
    api, state, $: (selector: string) => selector === '#content' ? content : form,
    ROLE_LABELS: {}, SCOPE_LABELS: {}, select: () => '', pagination: () => '', bindPagination: () => {},
    app: { userAction: async (id: string, action: string) => { events.push(`dispatch:${id}:${action}:${menu.open}`) } },
    toast: () => {}, errorText: (error: Error) => error.message,
  }
  const render = new Function(...Object.keys(deps), `${['esc', 'statusPill', 'canPermission', 'accountTabs', 'listQuery', 'renderUsers'].map(fn).join('\n')}\nreturn renderUsers`)(...Object.values(deps)) as () => Promise<void>
  return { content, menu, button, events, render }
}

describe('账号次要操作的可访问展开区', () => {
  it('保留详情入口，将获准的写操作收进带账号名称的展开区', async () => {
    const h = harness()
    await h.render()
    const html = h.content.innerHTML
    expect(html).toMatch(/data-user-action="detail"[\s\S]*<details class="account-more">/)
    expect(html).toContain('aria-label="「张三」更多操作"')
    const disclosure = html.match(/<details class="account-more">([\s\S]*?)<\/details>/)?.[1]
    expect(disclosure).toBeDefined()
    for (const action of ['edit', 'password', 'sessions', 'binding', 'delete']) {
      expect(disclosure).toContain(`data-user-action="${action}"`)
    }
    expect(disclosure).not.toContain('data-user-action="detail"')
  })

  it('只读账号没有更多操作，缺少SSO权限时不显示绑定', async () => {
    const readonly = harness(false)
    await readonly.render()
    expect(readonly.content.innerHTML).toContain('data-user-action="detail"')
    expect(readonly.content.innerHTML).not.toContain('<details')
    const noSso = harness(true, false)
    await noSso.render()
    expect(noSso.content.innerHTML).toContain('data-user-action="edit"')
    expect(noSso.content.innerHTML).not.toContain('data-user-action="binding"')
  })

  it('Escape收起展开区并恢复summary焦点，其他按键不拦截', async () => {
    const h = harness()
    await h.render()
    let prevented = 0
    const event = { key: 'Tab', preventDefault: () => { prevented++ }, stopPropagation() {} }
    h.menu.onkeydown?.(event)
    expect(h.menu.open).toBe(true)
    expect(h.events).toEqual([])
    h.menu.onkeydown?.({ ...event, key: 'Escape' })
    expect(h.menu.open).toBe(false)
    expect(h.events).toEqual(['summary:focus'])
    expect(prevented).toBe(1)
  })

  it('选择编辑先收起并恢复焦点，再启动现有账号动作', async () => {
    const h = harness()
    await h.render()
    await h.button.onclick?.()
    expect(h.events).toEqual(['summary:focus', 'dispatch:usr_target:edit:false'])
  })
})
