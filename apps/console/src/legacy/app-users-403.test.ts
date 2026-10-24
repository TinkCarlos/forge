import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')

function fnSource(name: string) {
  const m = APP.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!m) throw new Error(`app.js 里没有 function ${name}`)
  return m[0]
}

const USERS = { items: [{ id: 'usr_1', display_name: '张三', email: 'a@example.com', role: 'builder', data_scope: 'org', status: 'active' }] }

function render(permissions: () => Promise<unknown>) {
  const content = { innerHTML: '' }
  const state = { users: [] as unknown[] }
  const api = (path: string) => (path === '/admin/api/users' ? Promise.resolve(USERS) : permissions())
  const run = new Function('api', 'state', '$', `${['esc', 'empty', 'statusPill', 'renderUsers'].map(fnSource).join('\n')}\nreturn renderUsers()`)
  return { content, done: run(api, state, () => content) as Promise<void> }
}

const forbidden = () => Promise.reject(Object.assign(new Error('角色缺少权限: role.view'), { code: 'POL-2001', status: 403 }))

describe('K-37 旧版用户页：没有 role.view 时只显示用户列表', () => {
  it('permissions 403 时用户列表照常显示，角色下拉禁用并提示「无权限查看角色」', async () => {
    const { content, done } = render(forbidden)
    await done
    expect(content.innerHTML).toContain('张三')
    expect(content.innerHTML).toMatch(/<select id="role-usr_1"[^>]*\sdisabled/)
    expect(content.innerHTML).toMatch(/<option selected>builder<\/option>/)
    expect(content.innerHTML).toContain('无权限查看角色')
    expect(content.innerHTML).toMatch(/<button[^>]*disabled[^>]*>查看权限矩阵<\/button>/)
  })

  it('有权限时角色可选，没有提示', async () => {
    const { content, done } = render(() => Promise.resolve({ roles: { builder: [], operator: [] } }))
    await done
    expect(content.innerHTML).not.toMatch(/<select id="role-usr_1"[^>]*disabled/)
    expect(content.innerHTML).not.toContain('无权限查看角色')
    expect(content.innerHTML).toContain('<option >operator</option>')
  })

  it('permissions 的其它错误（如 500）仍然整页报错', async () => {
    const { done } = render(() => Promise.reject(Object.assign(new Error('内部错误'), { status: 500 })))
    await expect(done).rejects.toThrow('内部错误')
  })

  it('api() 的错误带 HTTP 状态码', async () => {
    const api = new Function('fetch', 'state', 'showLogin', `${fnSource('api')}\nreturn api`)(
      () => Promise.resolve({ status: 403, ok: false, text: () => Promise.resolve('{"error":{"code":"POL-2001","message":"x"}}') }),
      { session: null },
      () => {},
    ) as (p: string) => Promise<unknown>
    await expect(api('/admin/api/permissions')).rejects.toMatchObject({ status: 403, code: 'POL-2001' })
  })
})
