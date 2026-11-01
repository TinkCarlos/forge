import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
function fnSource(name: string) {
  const m = APP.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!m) throw new Error(`missing ${name}`)
  return m[0]
}
function render(perms: string[], fail = false) {
  const calls: string[] = []
  const content = { innerHTML: '', querySelectorAll: () => [] }
  const form = { onsubmit: null }
  const state = { tab:"users", session: { permissions: perms, user: { role: "org_admin" } }, users: [], userFilters: { q: '', status: '', cursor: '', history: [] } }
  const data = { items: [{ id: 'usr_1', username: 'zhangsan', display_name: '张三', email: 'a@example.com', role: 'builder', data_scope: 'org', status: 'active', can_manage: perms.includes('user.manage') }], grantableRoles: ['builder', 'user'], canCreate: perms.includes('user.manage'), nextCursor: null }
  const api = async (path: string) => { calls.push(path); if (fail) throw new Error('内部错误'); return data }
  const run = new Function('api', 'state', '$', 'ROLE_LABELS', 'SCOPE_LABELS', 'select', 'pagination', 'bindPagination', `${['esc','statusPill','canPermission','accountTabs','listQuery','renderUsers'].map(fnSource).join('\n')}\nreturn renderUsers()`)
  return { content, calls, done: run(api, state, (selector: string) => selector === '#content' ? content : form, {}, {}, () => '', () => '', () => {}) as Promise<void> }
}
describe('账号页依赖实际账号动作权限，不依赖角色目录读取权限', () => {
  it('没有role.view仍显示账号，不能管理时不显示写操作', async () => {
    const h = render(['user.view']); await h.done
    expect(h.content.innerHTML).toContain('张三')
    expect(h.content.innerHTML).not.toContain('data-user-action="edit"')
    expect(h.content.innerHTML).not.toContain('新增账号')
    expect(h.calls).toEqual(['/admin/api/users?limit=50'])
  })
  it('user.manage显示账号操作，不因缺role.view丢失账号页', async () => {
    const h = render(['user.view', 'user.manage']); await h.done
    expect(h.content.innerHTML).toContain('data-user-action="edit"')
    expect(h.content.innerHTML).toContain('重置密码')
    expect(h.content.innerHTML).toContain('新增账号')
    expect(h.content.innerHTML).not.toContain('功能权限矩阵')
  })
  it('账号接口失败仍报错，不能用空列表掩盖', async () => {
    await expect(render(['user.view'], true).done).rejects.toThrow('内部错误')
  })
  it('api错误携带状态码和字段信息，供表单保留草稿并定位', async () => {
    const api = new Function('fetch', 'state', 'showLogin', `${fnSource('api')}\nreturn api`)(
      () => Promise.resolve({ status: 400, ok: false, text: () => Promise.resolve('{"error":{"code":"CFG-8501","message":"x","details":{"field":"email"}}}') }), { session: null }, () => {},
    ) as (p: string) => Promise<unknown>
    await expect(api('/admin/api/users')).rejects.toMatchObject({ status: 400, code: 'CFG-8501', details: { field: 'email' } })
  })
})
