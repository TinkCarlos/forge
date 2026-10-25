import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * FE-R6 P3：Key 有效 scope = Key 的 scopes ∩ 应用当前 scopes（后端 fix/r3-backlog）。
 * - 应用新建 / 编辑表单的 Scopes 输入框下加一行 .hint 说明，输入框 aria-describedby 指向它。
 * - Key 列表（GET /admin/api/apps/:id/keys 返回 scopes_json）加一列「Scopes」，内容走 esc()。
 */
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const HINT_TEXT = '收窄会立即对已有 Key 生效；放宽只对之后新建的 Key 生效，已有 Key 需要重新创建。不支持 * 通配。'

function fnSource(name: string): string {
  const m = APP.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!m) throw new Error(`function ${name} not found in app.js`)
  return m[0]
}
function method(name: string): string {
  const m = APP.match(new RegExp(`^  (?:async )?${name}\\([^)]*\\) \\{[\\s\\S]*?^  \\},?$`, 'm'))
  if (!m) throw new Error(`method ${name} not found in app.js`)
  return m[0].replace(/,$/, '')
}

type Modal = { title: string; body: string; onSubmit: (d: unknown) => Promise<unknown> }

function harness(opts: { keys?: unknown[]; apps?: unknown[]; apiError?: Error } = {}) {
  const modals: Modal[] = []
  const calls: { path: string; opts: unknown }[] = []
  const toasts: { m: string; kind?: string }[] = []
  const deps: Record<string, unknown> = {
    openModal: (title: string, body: string, onSubmit: Modal['onSubmit']) => { modals.push({ title, body, onSubmit }) },
    state: { apps: opts.apps ?? [{ id: 'app_1', name: 'A', status: 'active', scopes: ['agents:read', 'runs:create'], webhookUrl: '' }] },
    api: async (path: string, o: unknown) => {
      calls.push({ path, opts: o })
      if (opts.apiError) throw opts.apiError
      return { items: opts.keys ?? [] }
    },
    toast: (m: string, kind?: string) => { toasts.push({ m, kind }) },
    errorText: (e: Error & { code?: string }) => (e.code ? `${e.message}（错误码 ${e.code}）` : e.message),
    idSeg: (s: string) => encodeURIComponent(s),
    renderApps: async () => {},
    fmt: (v: unknown) => (v ? String(v) : '-'),
  }
  const names = Object.keys(deps)
  const optional = ['appScopesHint', 'keyScopesText'].filter((n) => new RegExp(`^function ${n}\\(`, 'm').test(APP)).map(fnSource).join('\n')
  const consts = APP.match(/^const APP_SCOPES_HINT_ID = .*$/m)?.[0] ?? ''
  const fns = ['esc', 'field', 'select', 'statusPill'].map(fnSource).join('\n')
  const src = `${consts}\n${fns}\n${optional}\nreturn { ${method('openAppCreate')}, ${method('openAppEdit')}, ${method('listAppKeys')} };`
  const app = new Function(...names, src)(...names.map((n) => deps[n])) as {
    openAppCreate(): void
    openAppEdit(id: string): void
    listAppKeys(id: string): Promise<void>
  }
  return { app, modals, calls, toasts }
}

/** 从 HTML 里取 name="scopes" 的 input 标签和 aria-describedby 指向的元素。 */
function scopesHint(body: string) {
  const input = body.match(/<input[^>]*name="scopes"[^>]*>/)?.[0] ?? ''
  const describedBy = input.match(/aria-describedby="([^"]+)"/)?.[1]
  const hint = describedBy ? body.match(new RegExp(`<p([^>]*)id="${describedBy}"([^>]*)>([\\s\\S]*?)</p>`)) : null
  return { input, describedBy, hint }
}
const textOf = (html: string) => html.replace(/<[^>]+>/g, '')

for (const [label, open] of [
  ['新建应用表单', (h: ReturnType<typeof harness>) => h.app.openAppCreate()],
  ['编辑应用表单', (h: ReturnType<typeof harness>) => h.app.openAppEdit('app_1')],
] as const) {
  describe(`FE-R6 ${label}：Scopes 说明`, () => {
    it('Scopes 输入框 aria-describedby 指向一行 .hint 说明，文案准确', () => {
      const h = harness()
      open(h)
      const { input, describedBy, hint } = scopesHint(h.modals[0].body)
      expect(input).not.toBe('')
      expect(describedBy).toBeTruthy()
      expect(hint).not.toBeNull()
      expect(`${hint![1]} ${hint![2]}`).toMatch(/class="hint"/)
      expect(textOf(hint![3])).toBe(HINT_TEXT)
    })

    it('说明紧跟在 Scopes 输入框之后、在同一个 .full 容器里，且没有内联 style / on* 属性', () => {
      const h = harness()
      open(h)
      const body = h.modals[0].body
      const block = body.match(/<div class="full"><label>Scopes<input[^>]*name="scopes"[\s\S]*?<\/div>/)?.[0] ?? ''
      expect(block).toMatch(/<\/label><p class="hint"/)
      expect(block).not.toMatch(/\sstyle=/)
      expect(block).not.toMatch(/\son[a-z]+=/)
    })
  })
}

describe('FE-R6 编辑应用：已有行为不变', () => {
  it('Scopes 预填应用当前值，提交 body 不变；后端 400 CFG-8501 原样抛给 openModal 统一 toast', async () => {
    const err = Object.assign(new Error('scopes 不支持通配符'), { code: 'CFG-8501' })
    const h = harness({ apiError: err })
    h.app.openAppEdit('app_1')
    expect(scopesHint(h.modals[0].body).input).toMatch(/value="agents:read,runs:create"/)
    const fd = { get: (k: string) => ({ name: 'A', status: 'active', scopes: 'agents:read, runs:* ', webhookUrl: '', webhookSecret: '' } as Record<string, string>)[k] }
    await expect(h.modals[0].onSubmit(fd)).rejects.toBe(err)
    expect(h.calls[0]).toEqual({ path: '/admin/api/apps/app_1', opts: { method: 'PATCH', body: { name: 'A', status: 'active', scopes: ['agents:read', 'runs:*'], webhookUrl: '', webhookSecret: undefined } } })
  })
})

describe('FE-R6 Key 列表：Scopes 列', () => {
  it('表头有「Scopes」，每行显示该 Key 的 scopes_json', async () => {
    const h = harness({ keys: [{ name: 'default', prefix: 'fsk_abc', status: 'active', last_used_at: null, scopes_json: ['agents:read', 'runs:create'] }] })
    await h.app.listAppKeys('app_1')
    const body = h.modals[0].body
    const heads = [...body.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1])
    expect(heads).toContain('Scopes')
    const cells = [...(body.match(/<tbody>[\s\S]*<\/tbody>/)?.[0] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1])
    expect(cells).toHaveLength(heads.length)
    expect(cells[heads.indexOf('Scopes')]).toBe('agents:read, runs:create')
  })

  it('scopes 内容走 esc()，不会注入 HTML', async () => {
    const h = harness({ keys: [{ name: 'k', prefix: 'p', status: 'active', scopes_json: ['<img src=x onerror=alert(1)>', 'a"b'] }] })
    await h.app.listAppKeys('app_1')
    const body = h.modals[0].body
    expect(body).not.toContain('<img')
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;, a&quot;b')
  })

  it('scopes_json 缺失或不是数组时显示空，不报错', async () => {
    const h = harness({ keys: [{ name: 'k1', prefix: 'p1', status: 'active' }, { name: 'k2', prefix: 'p2', status: 'active', scopes_json: 'oops' }] })
    await h.app.listAppKeys('app_1')
    expect(h.toasts).toEqual([])
    const body = h.modals[0].body
    expect(body).toMatch(/<th>Scopes<\/th>/)
    expect(body).not.toContain('oops')
    expect(body).not.toContain('undefined')
  })
})
