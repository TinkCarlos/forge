import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SSE approval.resolved（旧版控制台 public/app.js）：Run 进入终态时后端把挂着的 pending 审批改成 expired，
 * 事务提交后发 approval.resolved { approvalId, decision: 'expired' }（排在 Run 终态事件之前；公开契约字段是 decision）。
 * - decision=expired：按已失效处理，不弹错误、不写 console.error：
 *   - approvalId 在当前审批列表里 → 从列表移除（审批页正显示时按本地数据重渲染，不重新请求）；
 *   - 该审批的确认框正开着 → 关掉，并给一条中性（非 error）轻提示「此审批已失效」；
 *   - 当前页面没有这个审批 → 静默忽略。
 * - 其他 decision（approved / rejected …）保持现有行为（只记事件日志）；未知值 / 缺字段容错，不抛异常。
 * - 不兼容读 status：只带 status:'expired'、不带 decision 的事件静默忽略。
 * - 唯一的 SSE 入口是 Run 弹窗（connectRunStream）；审批列表页本身不订阅 SSE。
 */
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const EXPIRED_TEXT = '此审批已失效'

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
/** 还没实现时给一个会失败的占位，让用例跑红而不是整个文件报错。 */
const resolvedSrc = () => (hasFn('onApprovalResolved') ? fnSource('onApprovalResolved') : 'function onApprovalResolved() { throw new Error("onApprovalResolved 未实现") }')

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

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
  scrollTop = 0
  scrollHeight = 0
  classList: ClassList
  history: string[] = []
  children: El[] = []
  onclick: ((e: unknown) => void) | null = null
  onsubmit: ((e: unknown) => Promise<void>) | null = null
  _data: Record<string, string> = {}
  private _text = ''
  private listeners: Record<string, { f: (e?: unknown) => void; once: boolean }[]> = {}
  constructor(cls = '') { this.classList = new ClassList(cls) }
  get textContent() { return this._text }
  set textContent(v: string) { this._text = v; this.history.push(v) }
  appendChild(c: El) { this.children.push(c); return c }
  addEventListener(t: string, f: (e?: unknown) => void, opts?: { once?: boolean }) {
    const l = (this.listeners[t] ??= [])
    if (!l.some((x) => x.f === f)) l.push({ f, once: !!opts?.once })
  }
  dispatch(t: string) { const l = this.listeners[t] ?? []; this.listeners[t] = l.filter((x) => !x.once); for (const x of l) x.f({}) }
  querySelector() { return null }
  querySelectorAll() { return [] as El[] }
}
class Dialog extends El {
  open = false
  showModal() { this.open = true }
  close() { if (!this.open) return; this.open = false; this.dispatch('close') }
}
class FakeES {
  static instances: FakeES[] = []
  static CLOSED = 2
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private listeners: Record<string, ((e: { data: string }) => void)[]> = {}
  constructor(public url: string) { FakeES.instances.push(this) }
  addEventListener(t: string, f: (e: { data: string }) => void) { (this.listeners[t] ??= []).push(f) }
  close() { this.readyState = 2 }
  emit(type: string, seq: number, data: unknown) { for (const f of this.listeners[type] ?? []) f({ data: JSON.stringify({ type, seq, data }) }) }
}

type Resp = { status: number; body?: unknown }
const SESSION = { csrfToken: 'c', user: { name: 'A', role: 'platform_admin', dataScope: 'all' } }
const LIST = '/admin/api/approvals'
const X = 'apr_01M5PK6G1GPZ3APBN3QNXR'
const Y = 'apr_01M5PK6G1GPZ3APBN3QNXS'
const RUN_X = 'run_01M5PK6G1GPZ3APBN3QNXR'
const RUN_Y = 'run_01M5PK6G1GPZ3APBN3QNXS'
const approval = (id: string, runId: string, over: Record<string, unknown> = {}) => ({
  id, run_id: runId, status: 'pending', risk_level: 'high', expires_at: '2026-10-25T05:49:00.000Z',
  created_at: '2026-10-25T05:19:00.000Z', agent_name: 'Bot', tool_name: 'send_mail', args_preview: '{}', reason: 'policy', attempt: null, ...over,
})
const list = (...items: unknown[]): Resp => ({ status: 200, body: { items } })
const run = (status: string) => ({ id: RUN_X, status, costUsd: 0, messages: [], toolCalls: [] })

/** 审批页 + 确认框 + 事件处理（app.decideApproval / renderApprovals / onApprovalResolved）。 */
function approvalsHarness(routes: Record<string, Resp | Resp[]>) {
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
  const fns = ['esc', 'errorText', 'toast', 'api', 'statusPill', 'empty', 'textarea', 'openModal', 'renderApprovals', 'approvalReason', 'attemptText', 'approvalReasonHtml']
  const consts = ['APPROVAL_STALE_CODES', 'APPROVAL_STALE_TEXT', 'APPROVAL_RUN_FINISHED_TEXT', 'APPROVAL_RESOLVED_EXPIRED_TEXT', 'INTERRUPTED_BADGE_TEXT'].map(constLine).join('\n')
  const src = `${consts}\n${fns.map(fnSource).join('\n')}\n${resolvedSrc()}\nreturn { renderApprovals, onApprovalResolved, ${method('decideApproval')} };`
  const app = new Function(...names, src)(...names.map((n) => deps[n])) as {
    renderApprovals(): Promise<void>
    onApprovalResolved(data: unknown): void
    decideApproval(id: string, decision: string): Promise<void>
  }
  return {
    app, els, modal, calls, state,
    content: () => els['#content'].innerHTML,
    toasts: () => els['#toast'].history,
    toastClass: () => els['#toast'].className,
    submit: async (comment = '') => { els['#modal-form']._data = { comment }; await els['#modal-form'].onsubmit?.({ preventDefault() {} }) },
    listCalls: () => calls.filter((c) => c === `GET ${LIST}`).length,
  }
}

/** Run 弹窗（唯一的 SSE 入口）+ 底下的审批页：app.openRun → connectRunStream。 */
function runHarness(approvals: unknown[], tab = 'approvals') {
  FakeES.instances = []
  const modal = new Dialog()
  const content = new El()
  const toastEl = new El('toast hidden')
  const els: Record<string, El> = {}
  const calls: string[] = []
  const state: Record<string, unknown> = { eventSource: null, runView: null, tab, approvals: [...approvals] }
  const deps: Record<string, unknown> = {
    state,
    $: (sel: string) => (sel === '#modal' ? modal : sel === '#content' ? content : sel === '#toast' ? toastEl : els[sel.replace(/^#/, '')] ?? null),
    document: { createElement: () => new El() },
    EventSource: FakeES,
    api: async (path: string) => { calls.push(path); return path === LIST ? { items: [] } : run('running') },
    openModal: (_t: string, body: string) => {
      for (const k of Object.keys(els)) delete els[k]
      for (const m of body.matchAll(/id="([^"]+)"/g)) els[m[1]] = new El()
      modal.showModal()
    },
    setTimeout: () => 0, clearTimeout: () => {},
    errorText: (e: Error) => e.message,
    fmt: (v: unknown) => (v ? `T(${String(v)})` : '—'),
  }
  const names = Object.keys(deps)
  const consts = ['RUN_TERMINAL_EVENTS', 'RUN_ACTIVE_STATUSES', 'STREAM_MAX_RETRIES', 'RUN_APPROVAL_EXPIRED_CODE', 'RUN_APPROVAL_EXPIRED_TEXT', 'APPROVAL_RESOLVED_EXPIRED_TEXT', 'INTERRUPTED_BADGE_TEXT'].map(constLine).join('\n')
  const fns = ['toast', 'isEntityId', 'idSeg', 'esc', 'statusPill', 'empty', 'runMessagesHtml', 'runToolsHtml', 'runToolbarHtml', 'renderRunView', 'renderStreamStatus', 'listenRun', 'connectRunStream', 'syncRunFromRest', 'endRunStream', 'closeStream', 'runFailureText', 'toolInterruptedText', 'runEventText', 'renderApprovals', 'approvalReason', 'attemptText', 'approvalReasonHtml']
  const body = `${consts}\n${fns.map(fnSource).join('\n')}\n${resolvedSrc()}\nreturn { ${method('openRun')} };`
  const app = new Function(...names, body)(...names.map((n) => deps[n])) as { openRun(id: string): Promise<void> }
  return {
    app, modal, content, state, calls,
    toasts: () => toastEl.history,
    es: () => FakeES.instances.at(-1)!,
    log: () => (els['event-log']?.children ?? []).map((c) => c.innerHTML),
  }
}

let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => { consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { expect(consoleError).not.toHaveBeenCalled(); consoleError.mockRestore() })

describe('approval.resolved decision=expired：审批列表', () => {
  it('approvalId 在列表里：移除这一行（按本地数据重渲染，不重新请求），不弹任何提示', async () => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X), approval(Y, RUN_Y)) })
    await h.app.renderApprovals()
    expect(h.content()).toContain(RUN_X)
    h.app.onApprovalResolved({ approvalId: X, decision: 'expired' })
    await flush()
    expect(h.content()).not.toContain(RUN_X)
    expect(h.content()).toContain(RUN_Y)
    expect((h.state.approvals as { id: string }[]).map((a) => a.id)).toEqual([Y])
    expect(h.listCalls()).toBe(1)
    expect(h.toasts()).toEqual([])
  })

  it('移除最后一条：显示空状态', async () => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X)) })
    await h.app.renderApprovals()
    h.app.onApprovalResolved({ approvalId: X, decision: 'expired' })
    await flush()
    expect(h.content()).toContain('没有待审批')
    expect(h.toasts()).toEqual([])
  })

  it('当前不在审批页：只更新本地列表，不改 #content', async () => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X)) })
    await h.app.renderApprovals()
    h.state.tab = 'runs'
    h.els['#content'].innerHTML = 'RUNS-PAGE'
    h.app.onApprovalResolved({ approvalId: X, decision: 'expired' })
    await flush()
    expect(h.content()).toBe('RUNS-PAGE')
    expect(h.state.approvals).toEqual([])
  })

  it('approvalId 不在当前页面：静默忽略（不重渲染、不提示）', async () => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X)) })
    await h.app.renderApprovals()
    h.els['#content'].innerHTML = 'UNCHANGED'
    h.app.onApprovalResolved({ approvalId: 'apr_01M5PK6G1GPZ3APBN3QNZZ', decision: 'expired' })
    await flush()
    expect(h.content()).toBe('UNCHANGED')
    expect(h.toasts()).toEqual([])
  })
})

describe('approval.resolved decision=expired：确认框', () => {
  it('该审批的确认框开着：关掉，并给中性轻提示「此审批已失效」（不是 error），列表同时移除', async () => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X), approval(Y, RUN_Y)) })
    await h.app.renderApprovals()
    await h.app.decideApproval(X, 'approved')
    expect(h.modal.open).toBe(true)
    h.app.onApprovalResolved({ approvalId: X, decision: 'expired' })
    await flush()
    expect(h.modal.open).toBe(false)
    expect(h.toasts()).toEqual([EXPIRED_TEXT])
    expect(h.toastClass()).not.toContain('error')
    expect(h.toastClass()).not.toContain('ok')
    expect(h.toastClass()).toContain('info')
    expect(h.content()).not.toContain(RUN_X)
    expect(h.calls.filter((c) => c.startsWith('POST'))).toEqual([])
  })

  it('驳回确认框同样处理', async () => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X)) })
    await h.app.renderApprovals()
    await h.app.decideApproval(X, 'rejected')
    h.app.onApprovalResolved({ approvalId: X, decision: 'expired' })
    expect(h.modal.open).toBe(false)
    expect(h.toasts()).toEqual([EXPIRED_TEXT])
  })

  it('开着的是另一条审批的确认框：不关、不提示（列表里的那条照样移除）', async () => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X), approval(Y, RUN_Y)) })
    await h.app.renderApprovals()
    await h.app.decideApproval(Y, 'approved')
    h.app.onApprovalResolved({ approvalId: X, decision: 'expired' })
    await flush()
    expect(h.modal.open).toBe(true)
    expect(h.toasts()).toEqual([])
    expect(h.content()).not.toContain(RUN_X)
  })

  it('确认框已被用户关掉：之后同一条的事件不再关别的弹窗、不提示', async () => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X)) })
    await h.app.renderApprovals()
    await h.app.decideApproval(X, 'approved')
    h.modal.close()
    h.modal.showModal() // 例如随后打开的 Run 弹窗
    h.app.onApprovalResolved({ approvalId: X, decision: 'expired' })
    expect(h.modal.open).toBe(true)
    expect(h.toasts()).toEqual([])
  })
})

describe('approval.resolved 其他 decision / 异常数据：保持现有行为，不抛异常', () => {
  it.each(['approved', 'rejected', 'pending', 'weird-status'])('decision=%s：列表和确认框都不动，不提示', async (decision) => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X)) })
    await h.app.renderApprovals()
    await h.app.decideApproval(X, 'approved')
    const before = h.content()
    expect(() => h.app.onApprovalResolved({ approvalId: X, decision })).not.toThrow()
    await flush()
    expect(h.content()).toBe(before)
    expect(h.modal.open).toBe(true)
    expect(h.toasts()).toEqual([])
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['字符串', 'expired'],
    ['缺 approvalId', { decision: 'expired' }],
    ['approvalId 不是字符串', { approvalId: 42, decision: 'expired' }],
    ['缺 decision', { approvalId: X }],
    ['只有 status=expired、没有 decision（不兼容读 status）', { approvalId: X, status: 'expired' }],
  ])('data=%s：不抛异常，不改动', async (_label, data) => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X)) })
    await h.app.renderApprovals()
    const before = h.content()
    expect(() => h.app.onApprovalResolved(data)).not.toThrow()
    await flush()
    expect(h.content()).toBe(before)
    expect(h.toasts()).toEqual([])
  })
})

describe('不兼容读 status：只看 decision', () => {
  it('只带 status=expired、不带 decision：列表不移除、确认框不关、不提示', async () => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X)) })
    await h.app.renderApprovals()
    await h.app.decideApproval(X, 'approved')
    const before = h.content()
    expect(() => h.app.onApprovalResolved({ approvalId: X, status: 'expired' })).not.toThrow()
    await flush()
    expect(h.content()).toBe(before)
    expect(h.state.approvals).toHaveLength(1)
    expect(h.modal.open).toBe(true)
    expect(h.toasts()).toEqual([])
  })

  it('status 与 decision 同时存在时以 decision 为准：decision=approved + status=expired 不处理', async () => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X)) })
    await h.app.renderApprovals()
    await h.app.decideApproval(X, 'approved')
    h.app.onApprovalResolved({ approvalId: X, decision: 'approved', status: 'expired' })
    await flush()
    expect(h.state.approvals).toHaveLength(1)
    expect(h.modal.open).toBe(true)
    expect(h.toasts()).toEqual([])
  })
})

describe('接线：Run 弹窗（唯一的 SSE 入口）收到 approval.resolved', () => {
  it('expired：记事件日志，并把底下审批页里的这一条移除；不提示、不重新请求列表', async () => {
    const h = runHarness([approval(X, RUN_X), approval(Y, RUN_Y)])
    await h.app.openRun(RUN_X)
    h.es().emit('approval.resolved', 7, { approvalId: X, decision: 'expired' })
    await flush()
    expect(h.log()).toHaveLength(1)
    expect(h.log()[0]).toContain('approval.resolved')
    expect((h.state.approvals as { id: string }[]).map((a) => a.id)).toEqual([Y])
    expect(h.content.innerHTML).not.toContain(RUN_X)
    expect(h.content.innerHTML).toContain(RUN_Y)
    expect(h.calls).not.toContain(LIST)
    expect(h.toasts()).toEqual([])
    expect(h.modal.open).toBe(true)
  })

  it('expired 后紧跟 run.failed：照常结束流，Run 弹窗不被关掉', async () => {
    const h = runHarness([approval(X, RUN_X)])
    await h.app.openRun(RUN_X)
    h.es().emit('approval.resolved', 7, { approvalId: X, decision: 'expired' })
    h.es().emit('run.failed', 8, { status: 'failed', output: null, error: { code: 'APR-2102', message: 'x' } })
    await flush()
    expect(h.log()).toHaveLength(2)
    expect(h.es().readyState).toBe(2)
    expect(h.modal.open).toBe(true)
    expect(h.toasts()).toEqual([])
  })

  it('approved / 未知 decision / 只带 status=expired：只记日志，列表不动', async () => {
    const h = runHarness([approval(X, RUN_X)])
    await h.app.openRun(RUN_X)
    h.content.innerHTML = 'UNCHANGED'
    h.es().emit('approval.resolved', 7, { approvalId: X, decision: 'approved' })
    h.es().emit('approval.resolved', 8, { approvalId: X, decision: '???' })
    h.es().emit('approval.resolved', 9, null)
    h.es().emit('approval.resolved', 10, { approvalId: X, status: 'expired' })
    await flush()
    expect(h.log()).toHaveLength(4)
    expect(h.content.innerHTML).toBe('UNCHANGED')
    expect(h.state.approvals).toHaveLength(1)
  })

  it('approvalId 不在当前页面：静默忽略', async () => {
    const h = runHarness([], 'runs')
    await h.app.openRun(RUN_X)
    h.content.innerHTML = 'RUNS-PAGE'
    h.es().emit('approval.resolved', 7, { approvalId: X, decision: 'expired' })
    await flush()
    expect(h.content.innerHTML).toBe('RUNS-PAGE')
    expect(h.toasts()).toEqual([])
  })
})

describe('护栏：审批操作的 409 处理不变', () => {
  const err409 = (code: string, message: string): Resp => ({ status: 409, body: { error: { code, message, requestId: 'r', details: null, retryable: false } } })
  const DECIDE = `/admin/api/approvals/${X}/decide`

  it('APR-2104：「该审批已失效，请刷新后处理新的审批」+ 关框 + 刷新', async () => {
    const h = approvalsHarness({ [LIST]: [list(approval(X, RUN_X)), list()], [DECIDE]: err409('APR-2104', '审批已处理或已过期') })
    await h.app.renderApprovals()
    await h.app.decideApproval(X, 'approved')
    await h.submit()
    expect(h.toasts()).toEqual(['该审批已失效，请刷新后处理新的审批（错误码 APR-2104）'])
    expect(h.toastClass()).toBe('toast error')
    expect(h.listCalls()).toBe(2)
    expect(h.modal.open).toBe(false)
  })

  it('RUN-7005：「Run 已结束，此审批已失效」+ 关框 + 刷新', async () => {
    const h = approvalsHarness({ [LIST]: [list(approval(X, RUN_X)), list()], [DECIDE]: err409('RUN-7005', 'Run 已结束，审批不可操作') })
    await h.app.renderApprovals()
    await h.app.decideApproval(X, 'rejected')
    await h.submit()
    expect(h.toasts()).toEqual(['Run 已结束，此审批已失效（错误码 RUN-7005）'])
    expect(h.toastClass()).toBe('toast error')
    expect(h.listCalls()).toBe(2)
    expect(h.modal.open).toBe(false)
  })

  it('CFG-8503：普通错误提示，不刷新，确认框保留', async () => {
    const h = approvalsHarness({ [LIST]: list(approval(X, RUN_X)), [DECIDE]: err409('CFG-8503', '资源状态冲突') })
    await h.app.renderApprovals()
    await h.app.decideApproval(X, 'approved')
    await h.submit()
    expect(h.toasts()).toEqual(['资源状态冲突（错误码 CFG-8503）'])
    expect(h.listCalls()).toBe(1)
    expect(h.modal.open).toBe(true)
  })

  it('成功后确认框关闭：之后同一条的 expired 事件不再提示', async () => {
    const h = approvalsHarness({ [LIST]: [list(approval(X, RUN_X)), list()], [DECIDE]: { status: 200, body: { ok: true } } })
    await h.app.renderApprovals()
    await h.app.decideApproval(X, 'approved')
    await h.submit()
    expect(h.toasts()).toEqual(['已批准，Run 将继续'])
    h.app.onApprovalResolved({ approvalId: X, decision: 'expired' })
    expect(h.toasts()).toEqual(['已批准，Run 将继续'])
  })
})
