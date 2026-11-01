import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * FE-R6 P3：旧版控制台「试运行」输入框必填。
 * - text 为空或只有空白：不发请求、弹窗不关、表单内显示「请输入内容」、聚焦输入框、aria-invalid。
 * - 有内容：text 原样发送（不 trim），行为不变。
 * - openModal：onSubmit 返回 false 时保持弹窗打开；其他返回值照旧关闭。
 * - 定时任务「立即运行」body 仍是 {}，不受影响。
 */
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')

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

class El {
  id = ''
  textContent = ''
  innerHTML = ''
  className = ''
  type = ''
  disabled = false
  hidden = false
  value = ''
  focused = false
  onclick: (() => void) | null = null
  onsubmit: ((e: { preventDefault(): void }) => Promise<void>) | null = null
  attrs: Record<string, string> = {}
  private listeners: Record<string, { f: () => void; once: boolean }[]> = {}
  constructor(public sub: Record<string, El> = {}) {}
  setAttribute(k: string, v: string) { this.attrs[k] = String(v) }
  removeAttribute(k: string) { delete this.attrs[k] }
  getAttribute(k: string) { return this.attrs[k] ?? null }
  focus() { this.focused = true }
  addEventListener(t: string, f: () => void, opts?: { once?: boolean }) { (this.listeners[t] ??= []).push({ f, once: !!opts?.once }) }
  dispatch(t: string) {
    const ls = this.listeners[t] ?? []
    this.listeners[t] = ls.filter((l) => !l.once)
    for (const l of ls) l.f()
  }
  querySelector(sel: string) { return this.sub[sel] ?? null }
  querySelectorAll() { return [] }
}

function harness() {
  const calls: { path: string; opts: unknown }[] = []
  const toasts: string[] = []
  let closed = 0
  const textareaEl = new El()
  const body = new El({ 'textarea[name="text"]': textareaEl, '[name="text"]': textareaEl })
  const dialog = Object.assign(new El(), { showModal() {}, close() { closed++ } })
  const form = new El()
  const els: Record<string, El> = { '#modal': dialog, '#modal-title': new El(), '#modal-body': body, '#modal-submit': new El(), '#modal-form': form }
  const $ = (sel: string) => {
    if (els[sel]) return els[sel]
    // 按 body 里的 id 动态创建（例如提示元素）
    const id = sel.replace(/^#/, '')
    if (sel.startsWith('#') && body.innerHTML.includes(`id="${id}"`)) return (els[sel] = Object.assign(new El(), { id, hidden: /id="[^"]+"[^>]*\shidden/.test(body.innerHTML.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0] ?? '') }))
    return null
  }
  let versionId = '01J00000000000000000000022'
  class FD { get(k: string) { return k === 'text' ? textareaEl.value : k === 'versionId' ? versionId : null } }
  const deps: Record<string, unknown> = { bindConfigurationFields: () => {},
    $,
    FormData: FD,
    state: { session:{permissions:['*']}, agents: [{ id: 'agt_1', name: 'A' }], tab: 'agents' },
    api: async (path: string, opts: unknown) => {
      if (!opts) return { versions: [{ id: '01J00000000000000000000022', version: '1.1.0', status: 'draft' }, { id: '01J00000000000000000000021', version: '1.0.0', status: 'published' }] }
      calls.push({ path, opts }); return { runId: 'run_1' }
    },
    toast: (m: string) => { toasts.push(m) },
    errorText: (e: Error) => e.message,
    agentNameById: () => 'A',
    idSeg: (s: string) => encodeURIComponent(s),
    switchTab: async () => {},
    setTimeout: () => 0,
    app: { openRun() {} },
  }
  const names = Object.keys(deps)
  const optional = ['showFieldError'].filter((n) => new RegExp(`^function ${n}\\(`, 'm').test(APP)).map(fnSource).join('\n')
  const fns = ['canPermission', 'esc', 'textarea', 'select', 'vLabel', 'openModal'].map(fnSource).join('\n')
  const src = `${fns}\n${optional}\nreturn { openModal, ${method('openAgentRun')} };`
  const api = new Function(...names, src)(...names.map((n) => deps[n])) as { openModal: (...a: unknown[]) => void; openAgentRun(id: string): Promise<void> }
  const submit = async () => { await form.onsubmit!({ preventDefault() {} }) }
  return { api, calls, toasts, body, textareaEl, $, submit, setVersion: (id: string) => { versionId = id }, closed: () => closed }
}

const errorEl = (h: ReturnType<typeof harness>) => {
  const id = h.body.innerHTML.match(/<[^>]*role="alert"[^>]*>/)?.[0]?.match(/id="([^"]+)"/)?.[1]
  return id ? h.$(`#${id}`) : null
}

describe('FE-R6 试运行输入框必填', () => {
  for (const [label, value] of [['空字符串', ''], ['只有空格/换行/制表', '  \n\t  '], ['全角空格', '\u3000\u3000']] as const) {
    it(`${label}：不发请求、不关弹窗、显示「请输入内容」并聚焦输入框`, async () => {
      const h = harness()
      await h.api.openAgentRun('agt_1')
      h.textareaEl.value = value
      await h.submit()
      expect(h.calls).toEqual([])
      expect(h.closed()).toBe(0)
      expect(h.toasts).toEqual([])
      const err = errorEl(h)
      expect(err).not.toBeNull()
      expect(err!.hidden).toBe(false)
      expect(err!.textContent).toBe('请输入内容')
      expect(h.textareaEl.focused).toBe(true)
      expect(h.textareaEl.getAttribute('aria-invalid')).toBe('true')
    })
  }

  it('有内容时 text 原样发送（不 trim），弹窗关闭，行为不变', async () => {
    const h = harness()
    await h.api.openAgentRun('agt_1')
    h.textareaEl.value = '  你好 \n'
    await h.submit()
    expect(h.calls).toEqual([{ path: '/admin/api/agents/agt_1/run', opts: { method: 'POST', body: { versionId: '01J00000000000000000000022', input: { text: '  你好 \n' } } } }])
    expect(h.closed()).toBe(1)
    expect(h.toasts).toEqual(['Run 已创建：run_1'])
  })

  it('先空提交出提示，修改输入后提示消失，再提交正常发送', async () => {
    const h = harness()
    await h.api.openAgentRun('agt_1')
    h.textareaEl.value = ' '
    await h.submit()
    const err = errorEl(h)!
    expect(err.hidden).toBe(false)
    h.textareaEl.value = 'hi'
    h.textareaEl.dispatch('input')
    expect(err.hidden).toBe(true)
    expect(h.textareaEl.getAttribute('aria-invalid')).toBeNull()
    await h.submit()
    expect(h.calls).toHaveLength(1)
    expect(h.closed()).toBe(1)
  })

  it('表单标记：提示元素 role=alert 且默认 hidden，输入框 aria-required 并关联提示；无内联 style= / on*=', async () => {
    const h = harness()
    await h.api.openAgentRun('agt_1')
    const html = h.body.innerHTML
    const errTag = html.match(/<[^>]*role="alert"[^>]*>/)?.[0] ?? ''
    expect(errTag).toMatch(/\shidden/)
    const errId = errTag.match(/id="([^"]+)"/)?.[1]
    expect(errId).toBeTruthy()
    const ta = html.match(/<textarea[^>]*>/)?.[0] ?? ''
    expect(ta).toContain('aria-required="true"')
    expect(ta).toContain(`aria-describedby="${errId}"`)
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/i)
    expect(method('openAgentRun')).not.toMatch(/\sstyle=|\son[a-z]+=/i)
  })

  it('explicitly selected published version is sent without falling back to the draft', async () => {
    const h = harness()
    await h.api.openAgentRun('agt_1')
    h.setVersion('01J00000000000000000000021')
    h.textareaEl.value = 'check live'
    await h.submit()
    expect(h.calls[0]).toMatchObject({ opts: { body: { versionId: '01J00000000000000000000021' } } })
  })

  it('a stale or invalid version cannot create a Run', async () => {
    const h = harness()
    await h.api.openAgentRun('agt_1')
    h.setVersion('missing')
    h.textareaEl.value = 'check'
    await h.submit()
    expect(h.calls).toEqual([])
    expect(h.closed()).toBe(0)
    expect(h.toasts).toContain('请选择有效的试运行版本')
  })

  it('openModal：onSubmit 返回 false 保持打开；返回 undefined 照旧关闭', async () => {
    const h = harness()
    h.api.openModal('t', '<p></p>', async () => false)
    await h.submit()
    expect(h.closed()).toBe(0)
    h.api.openModal('t', '<p></p>', async () => undefined)
    await h.submit()
    expect(h.closed()).toBe(1)
  })

  it('定时任务「立即运行」仍发 body {}，不受必填影响', () => {
    expect(APP).toContain('await api(`/admin/api/schedules/${idSeg(id)}/run`, { method: "POST", body: {} });')
  })
})
