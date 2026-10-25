import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * R9：Worker 接手中断后的审批（旧版控制台 public/app.js）。
 * - 审批列表：reason=interrupted 显示「执行中断，可能已执行过」徽标，attempt 是正整数时旁边写「第 N 次尝试」；
 *   policy 或 reason 缺失（老后端）和原来一样，不显示徽标。
 * - 过期时间沿用 fmt（本地时间），没有 expires_at 显示「—」。
 * - 批准 / 驳回收到 409 APR-2104（审批已处理或已过期）或 APR-2103（并发决定）：弹专门提示「该审批已失效，请刷新后处理新的审批」，
 *   关掉确认框并自动刷新列表；其他 409（RUN-7005、通用冲突 CFG-8503）和 500 照旧走 errorText，不刷新、确认框保留。
 * - 所有后端字段都要转义，不能拼出 HTML。
 */
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const STALE = '该审批已失效，请刷新后处理新的审批'
const BADGE = '执行中断，可能已执行过'

function fnSource(name: string): string {
  const m = APP.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!m) throw new Error(`function ${name} not found in app.js`)
  return m[0]
}
const hasFn = (n: string) => new RegExp(`^(?:async )?function ${n}\\(`, 'm').test(APP)
const constLine = (n: string) => APP.match(new RegExp(`^const ${n} = .*$`, 'm'))?.[0] ?? ''
function method(name: string): string {
  const m = APP.match(new RegExp(`^  (?:async )?${name}\\([^)]*\\) \\{[\\s\\S]*?^  \\},?$`, 'm'))
  if (!m) throw new Error(`method ${name} not found in app.js`)
  return m[0].replace(/,$/, '')
}

class ClassList {
  s = new Set<string>()
  constructor(init = '') { init.split(/\s+/).filter(Boolean).forEach((c) => this.s.add(c)) }
  add(c: string) { this.s.add(c) }
  remove(c: string) { this.s.delete(c) }
  toggle(c: string, on?: boolean) { (on ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c) }
  contains(c: string) { return this.s.has(c) }
}
class El {
  innerHTML = ''
  className = ''
  type = ''
  disabled = false
  classList: ClassList
  history: string[] = []
  private _text = ''
  onsubmit: ((e: unknown) => Promise<void>) | null = null
  _data: Record<string, string> = {}
  constructor(cls = '') { this.classList = new ClassList(cls) }
  get textContent() { return this._text }
  set textContent(v: string) { this._text = v; this.history.push(v) }
  addEventListener() {}
  querySelector() { return null }
  querySelectorAll() { return [] as El[] }
}
class Dialog extends El {
  open = false
  showModal() { this.open = true }
  close() { this.open = false }
}

type Resp = { status: number; body?: unknown }
const SESSION = { csrfToken: 'c', user: { name: 'A', role: 'platform_admin', dataScope: 'all' } }
const LIST = '/admin/api/approvals'
const APR_ID = 'apr_01M5PK6G1GPZ3APBN3QNXR'
const RUN_ID = 'run_01M5PK6G1GPZ3APBN3QNXR'
const DECIDE = `/admin/api/approvals/${APR_ID}/decide`

const approval = (over: Record<string, unknown> = {}) => ({
  id: APR_ID, run_id: RUN_ID, status: 'pending', risk_level: 'high', expires_at: '2026-10-25T05:49:00.000Z',
  created_at: '2026-10-25T05:19:00.000Z', agent_name: 'Bot', tool_name: 'send_mail', args_preview: '{}', ...over,
})

function harness(routes: Record<string, Resp | Resp[]>) {
  const modal = new Dialog()
  const els: Record<string, El> = {
    '#modal': modal, '#modal-title': new El(), '#modal-body': new El(), '#modal-submit': new El(), '#modal-form': new El(),
    '#toast': new El('toast hidden'), '#content': new El(), '#login-view': new El('hidden'), '#app-view': new El(),
  }
  const calls: string[] = []
  const fetch = async (path: string, init: { method?: string } = {}) => {
    calls.push(`${init.method ?? 'GET'} ${path}`)
    const r = routes[path]
    const resp = (Array.isArray(r) ? (r.length > 1 ? r.shift() : r[0]) : r) ?? { status: 200, body: {} }
    return { status: resp.status, ok: resp.status >= 200 && resp.status < 300, text: async () => (resp.body === undefined ? '' : JSON.stringify(resp.body)) }
  }
  const state: Record<string, unknown> = { session: SESSION, tab: 'approvals', approvals: [] }
  const deps: Record<string, unknown> = {
    $: (sel: string) => els[sel] ?? null, document: { querySelectorAll: () => [] }, fetch, state,
    setTimeout: () => 0, clearTimeout: () => {},
    FormData: class { constructor(public f: El) {} get(k: string) { return this.f?._data?.[k] ?? null } },
    idSeg: (s: string) => encodeURIComponent(s), fmt: (v: unknown) => (v ? `T(${String(v)})` : '—'),
    handleSessionExpired: () => {}, showLogin: () => {},
  }
  const names = Object.keys(deps)
  const fns = ['esc', 'errorText', 'toast', 'api', 'statusPill', 'empty', 'textarea', 'openModal', 'renderApprovals']
  const optional = ['approvalReason', 'attemptText', 'approvalReasonHtml'].filter(hasFn)
  const consts = ['APPROVAL_STALE_CODES', 'APPROVAL_STALE_TEXT', 'INTERRUPTED_BADGE_TEXT'].map(constLine).join('\n')
  const src = `${consts}\n${[...fns, ...optional].map(fnSource).join('\n')}\nreturn { renderApprovals, ${method('decideApproval')} };`
  const app = new Function(...names, src)(...names.map((n) => deps[n])) as {
    renderApprovals(): Promise<void>
    decideApproval(id: string, decision: string): Promise<void>
  }
  return {
    app, els, modal, calls, state,
    content: () => els['#content'].innerHTML,
    toasts: () => els['#toast'].history,
    submit: async (comment = '') => {
      els['#modal-form']._data = { comment }
      await els['#modal-form'].onsubmit?.({ preventDefault() {} })
    },
    listCalls: () => calls.filter((c) => c === `GET ${LIST}`).length,
  }
}

const list = (...items: unknown[]): Resp => ({ status: 200, body: { items } })

describe('R9 审批列表：中断徽标与尝试次数', () => {
  it('reason=interrupted、attempt=2：显示徽标和「第 2 次尝试」', async () => {
    const h = harness({ [LIST]: list(approval({ reason: 'interrupted', attempt: 2 })) })
    await h.app.renderApprovals()
    expect(h.content()).toContain(BADGE)
    expect(h.content()).toMatch(/class="pill warn">执行中断，可能已执行过</)
    expect(h.content()).toContain('第 2 次尝试')
  })

  it('reason=interrupted、attempt=null：有徽标，不显示「第 N 次尝试」', async () => {
    const h = harness({ [LIST]: list(approval({ reason: 'interrupted', attempt: null })) })
    await h.app.renderApprovals()
    expect(h.content()).toContain(BADGE)
    expect(h.content()).not.toContain('次尝试')
  })

  it('reason=policy：和原来一样，没有徽标', async () => {
    const h = harness({ [LIST]: list(approval({ reason: 'policy', attempt: null })) })
    await h.app.renderApprovals()
    expect(h.content()).not.toContain(BADGE)
    expect(h.content()).not.toContain('次尝试')
    expect(h.content()).toMatch(/<td><span class="pill ">high<\/span><\/td>/)
  })

  it('reason 缺失（老后端）：按 policy 处理，没有徽标', async () => {
    const h = harness({ [LIST]: list(approval()) })
    await h.app.renderApprovals()
    expect(h.content()).not.toContain(BADGE)
    expect(h.content()).toContain(RUN_ID)
  })

  it('过期时间按 fmt 显示；没有 expires_at 时显示「—」', async () => {
    const h = harness({ [LIST]: list(approval({ reason: 'interrupted', attempt: 1 }), approval({ id: 'apr_01M5PK6G1GPZ3APBN3QNXS', expires_at: null })) })
    await h.app.renderApprovals()
    expect(h.content()).toContain('T(2026-10-25T05:49:00.000Z)')
    expect(h.content()).toContain('<td>—</td>')
  })

  it('XSS：字段都被转义；未知 reason 不出徽标，非整数 attempt 不显示', async () => {
    const evil = '<img src=x onerror=alert(1)>'
    const h = harness({ [LIST]: list(
      approval({ agent_name: evil, reason: 'interrupted', attempt: evil }),
      approval({ id: 'apr_01M5PK6G1GPZ3APBN3QNXS', reason: evil, attempt: 3 }),
    ) })
    await h.app.renderApprovals()
    expect(h.content()).not.toContain('<img')
    expect(h.content()).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(h.content().split(BADGE).length - 1).toBe(1)
    expect(h.content()).not.toContain('次尝试')
  })
})

describe('R9 批准/驳回：409 APR-2104 / APR-2103 专门提示并刷新', () => {
  const stale409 = (code: string): Resp => ({ status: 409, body: { error: { code, message: '审批已处理或已过期', requestId: 'r', details: null, retryable: false } } })
  const STALE_409 = stale409('APR-2104')

  it('批准收到 409 APR-2104：弹「该审批已失效…」（不弹后端原文），关确认框，自动刷新列表', async () => {
    const h = harness({ [LIST]: [list(approval({ reason: 'interrupted', attempt: 1 })), list()], [DECIDE]: STALE_409 })
    await h.app.renderApprovals()
    await h.app.decideApproval(APR_ID, 'approved')
    expect(h.modal.open).toBe(true)
    await h.submit()
    expect(h.toasts()).toEqual([`${STALE}（错误码 APR-2104）`])
    expect(h.els['#toast'].className).toBe('toast error')
    expect(h.toasts().join()).not.toContain('审批已处理或已过期')
    expect(h.listCalls()).toBe(2)
    expect(h.content()).not.toContain(BADGE)
    expect(h.modal.open).toBe(false)
  })

  it('驳回收到 409 APR-2103（并发决定）：同样专门提示并刷新', async () => {
    const h = harness({ [LIST]: [list(approval()), list()], [DECIDE]: stale409('APR-2103') })
    await h.app.renderApprovals()
    await h.app.decideApproval(APR_ID, 'rejected')
    await h.submit()
    expect(h.toasts()).toEqual([`${STALE}（错误码 APR-2103）`])
    expect(h.listCalls()).toBe(2)
  })

  it('护栏：409 CFG-8503（通用资源状态冲突）不当作审批失效，照普通错误提示，不刷新，确认框保留', async () => {
    const h = harness({ [LIST]: list(approval()), [DECIDE]: { status: 409, body: { error: { code: 'CFG-8503', message: '资源状态冲突' } } } })
    await h.app.renderApprovals()
    await h.app.decideApproval(APR_ID, 'approved')
    await h.submit()
    expect(h.toasts()).toEqual(['资源状态冲突（错误码 CFG-8503）'])
    expect(h.listCalls()).toBe(1)
    expect(h.modal.open).toBe(true)
  })

  it('非 409 的 APR-2104 不当作审批失效', async () => {
    const h = harness({ [LIST]: list(approval()), [DECIDE]: { status: 400, body: { error: { code: 'APR-2104', message: '参数错误' } } } })
    await h.app.renderApprovals()
    await h.app.decideApproval(APR_ID, 'approved')
    await h.submit()
    expect(h.toasts()).toEqual(['参数错误（错误码 APR-2104）'])
    expect(h.listCalls()).toBe(1)
  })

  it('其他 409（RUN-7005）：照旧走 errorText，不刷新，确认框保留', async () => {
    const h = harness({ [LIST]: list(approval()), [DECIDE]: { status: 409, body: { error: { code: 'RUN-7005', message: 'Run 已结束，审批不可操作' } } } })
    await h.app.renderApprovals()
    await h.app.decideApproval(APR_ID, 'approved')
    await h.submit()
    expect(h.toasts()).toEqual(['Run 已结束，审批不可操作（错误码 RUN-7005）'])
    expect(h.listCalls()).toBe(1)
    expect(h.modal.open).toBe(true)
  })

  it('500：照旧走 errorText，不刷新，确认框保留', async () => {
    const h = harness({ [LIST]: list(approval()), [DECIDE]: { status: 500, body: { error: { code: 'SYS-9001', message: '服务器内部错误' } } } })
    await h.app.renderApprovals()
    await h.app.decideApproval(APR_ID, 'rejected')
    await h.submit()
    expect(h.toasts()).toEqual(['服务器内部错误（错误码 SYS-9001）'])
    expect(h.listCalls()).toBe(1)
    expect(h.modal.open).toBe(true)
  })

  it('成功：行为不变（成功提示 + 刷新）', async () => {
    const h = harness({ [LIST]: [list(approval()), list()], [DECIDE]: { status: 200, body: { ok: true } } })
    await h.app.renderApprovals()
    await h.app.decideApproval(APR_ID, 'approved')
    await h.submit('ok')
    expect(h.toasts()).toEqual(['已批准，Run 将继续'])
    expect(h.listCalls()).toBe(2)
    expect(h.modal.open).toBe(false)
  })

  it('批准中断审批时确认框提示「批准会再执行一次」；policy 审批不提示', async () => {
    const h = harness({ [LIST]: list(approval({ reason: 'interrupted', attempt: 1 }), approval({ id: 'apr_01M5PK6G1GPZ3APBN3QNXS' })) })
    await h.app.renderApprovals()
    await h.app.decideApproval(APR_ID, 'approved')
    expect(h.els['#modal-body'].innerHTML).toContain('批准会再执行一次')
    await h.app.decideApproval('apr_01M5PK6G1GPZ3APBN3QNXS', 'approved')
    expect(h.els['#modal-body'].innerHTML).not.toContain('再执行一次')
  })
})

describe('R9 严格 CSP', () => {
  it('新增的审批渲染代码没有 style= 和 on*= 属性', () => {
    const src = ['approvalReason', 'attemptText', 'approvalReasonHtml'].map(fnSource).join('\n')
    expect(src).not.toMatch(/style=/)
    expect(src).not.toMatch(/\son[a-z]+="/)
  })
})
