import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * FE-R6 P3：旧版控制台 401 统一处理（api() 的 401 分支）。
 * - 会话过期：关掉所有打开的 <dialog>、closeStream()、showLogin()，提示一次「登录已过期，请重新登录」，错误带 status=401。
 * - 同一轮连续多个 401 只提示一次；重新登录后重置。
 * - 登录请求本身 401（密码错）：不提示过期，照旧显示失败原因。会话检查（启动 /auth/session）401：安静显示登录页。
 * - 403 / 5xx 不变：走原来的 toast，不跳登录页。
 * 用例 ID 对应测试工程师的 AUTH-401-01..05。
 */
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const EXPIRED = '登录已过期，请重新登录'

function fnSource(name: string): string {
  const m = APP.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!m) throw new Error(`function ${name} not found in app.js`)
  return m[0]
}
const hasFn = (n: string) => new RegExp(`^(?:async )?function ${n}\\(`, 'm').test(APP)
function method(name: string): string {
  const m = APP.match(new RegExp(`^  (?:async )?${name}\\([^)]*\\) \\{[\\s\\S]*?^  \\},?$`, 'm'))
  if (!m) throw new Error(`method ${name} not found in app.js`)
  return m[0].replace(/,$/, '')
}
const constLine = (n: string) => APP.match(new RegExp(`^const ${n} = .*$`, 'm'))?.[0] ?? ''

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
  hidden = false
  scrollTop = 0
  scrollHeight = 0
  onclick: unknown = null
  onsubmit: ((e: { preventDefault(): void; target?: unknown }) => Promise<void>) | null = null
  classList: ClassList
  private _text = ''
  history: string[] = []
  listeners: Record<string, ((e?: unknown) => unknown)[]> = {}
  children: El[] = []
  constructor(cls = '') { this.classList = new ClassList(cls) }
  get textContent() { return this._text }
  set textContent(v: string) { this._text = v; this.history.push(v) }
  addEventListener(t: string, f: (e?: unknown) => unknown) { (this.listeners[t] ??= []).push(f) }
  querySelector() { return null }
  querySelectorAll() { return [] as El[] }
  appendChild(c: El) { this.children.push(c) }
  setAttribute() {}
  removeAttribute() {}
}
class Dialog extends El {
  open = false
  closes = 0
  showModal() { this.open = true }
  close() { if (!this.open) return; this.open = false; this.closes++; for (const f of this.listeners.close ?? []) f() }
}

type Resp = { status: number; body?: unknown }
function harness(routes: Record<string, Resp | ((n: number) => Resp)> = {}) {
  const requests: { path: string; method: string }[] = []
  const hits: Record<string, number> = {}
  const sources: { url: string; closed: boolean; readyState: number; listeners: Record<string, ((e: unknown) => void)[]>; onopen?: () => void; onerror?: () => void; close(): void; addEventListener(t: string, f: (e: unknown) => void): void }[] = []
  const modal = new Dialog()
  const otherDialog = new Dialog()
  const els: Record<string, El> = {
    '#modal': modal, '#modal-title': new El(), '#modal-body': new El(), '#modal-submit': new El(), '#modal-form': new El(),
    '#login-view': new El('login-shell hidden'), '#app-view': new El('app-shell'), '#toast': new El('toast hidden'),
    '#login-form': new El(), '#sso-login': new El('hidden'), '#login-hint': new El(), '#logout': new El(), '#refresh': new El(),
    '#run-toolbar': new El(), '#run-messages': new El(), '#run-tools': new El(), '#run-stream': new El(), '#event-log': new El(),
    '#user-chip': new El(), '#content': new El(),
  }
  const $ = (sel: string) => els[sel] ?? null
  const document = {
    querySelectorAll: (sel: string) => (sel === 'dialog[open]' ? [modal, otherDialog].filter((d) => d.open) : []),
    createElement: () => new El(),
  }
  const fetch = async (path: string, init: { method?: string } = {}) => {
    requests.push({ path, method: init.method ?? 'GET' })
    hits[path] = (hits[path] ?? 0) + 1
    const r = routes[path]
    const resp = typeof r === 'function' ? r(hits[path]) : (r ?? { status: 200, body: {} })
    return { status: resp.status, ok: resp.status >= 200 && resp.status < 300, text: async () => (resp.body === undefined ? '' : JSON.stringify(resp.body)) }
  }
  class EventSourceStub {
    static CLOSED = 2
    readyState = 1
    closed = false
    listeners: Record<string, ((e: unknown) => void)[]> = {}
    onopen?: () => void
    onerror?: () => void
    constructor(public url: string) { requests.push({ path: url, method: 'SSE' }); sources.push(this) }
    addEventListener(t: string, f: (e: unknown) => void) { (this.listeners[t] ??= []).push(f) }
    close() { this.closed = true; this.readyState = 2 }
  }
  const state: Record<string, unknown> = { session: { csrfToken: 'c', user: { name: 'A', role: 'platform_admin', dataScope: 'all' } }, apps: [{ revision: 1, id: 'app_1', name: 'A', status: 'active', scopes: ['agents:read'], webhookUrl: '' }], runView: null, eventSource: null }
  const winListeners: string[] = []
  let switched = 0
  const deps: Record<string, unknown> = { bindConfigurationFields: () => {},
    $, document, fetch, EventSource: EventSourceStub, state,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    window: { addEventListener: (t: string) => winListeners.push(t) },
    location: { hash: '' },
    FormData: class { constructor(public f: { _data?: Record<string, string> }) {} get(k: string) { return this.f?._data?.[k] ?? null } },
    bindAgentActions: () => {}, onHashChange: () => {}, renderCurrent: async () => {},
    checkHealth: () => {}, renderNav: () => {}, switchTab: async () => { switched++ },
    idSeg: (s: string) => encodeURIComponent(s), renderApps: async () => {}, fmt: (v: unknown) => String(v ?? '—'),
  }
  const names = Object.keys(deps)
  const fnNames = ['revisionHeaders', 'esc', 'errorText', 'toast', 'api', 'showLogin', 'showApp', 'init', 'enterApp', 'statusPill', 'field', 'select',
    'openModal', 'runMessagesHtml', 'runToolsHtml', 'runFailureText', 'toolInterruptedText', 'runEventText', 'runToolbarHtml', 'renderRunView', 'renderStreamStatus', 'listenRun', 'connectRunStream',
    'syncRunFromRest', 'endRunStream', 'closeStream']
  const optional = ['handleSessionExpired', 'appScopeFields', 'appScopesHint', 'credentialReferenceField', 'credentialReferenceChange', 'canManageSecrets'].filter(hasFn)
  const consts = ['RUN_TERMINAL_EVENTS', 'RUN_ACTIVE_STATUSES', 'STREAM_MAX_RETRIES', 'RUN_APPROVAL_EXPIRED_CODE', 'RUN_APPROVAL_EXPIRED_TEXT', 'SESSION_EXPIRED_TEXT', 'APP_SCOPES_HINT_ID'].map(constLine).join('\n')
  const src = `${consts}\n${[...fnNames, ...optional].map(fnSource).join('\n')}\nreturn { api, init, enterApp, openModal, listenRun, syncRunFromRest, closeStream, ${method('openAppEdit')} };`
  const app = new Function(...names, src)(...names.map((n) => deps[n])) as {
    api(path: string, o?: Record<string, unknown>): Promise<unknown>
    init(): Promise<void>
    enterApp(): Promise<void>
    openModal(t: string, b: string, f: (d: unknown) => Promise<unknown>, l?: string): void
    listenRun(id: string, status: string): void
    syncRunFromRest(view: unknown, o?: { notify?: boolean }): Promise<void>
    closeStream(): void
    openAppEdit(id: string): void
  }
  const toasts = () => els['#toast'].history
  const loginVisible = () => !els['#login-view'].classList.contains('hidden')
  const appHidden = () => els['#app-view'].classList.contains('hidden')
  const submitModal = async (data: Record<string, string> = {}) => {
    ;(els['#modal-form'] as unknown as { _data: Record<string, string> })._data = data
    await els['#modal-form'].onsubmit!({ preventDefault() {} })
  }
  return { app, els, modal, otherDialog, state, requests, sources, toasts, loginVisible, appHidden, submitModal, switched: () => switched }
}

const R401 = { status: 401, body: { error: { code: 'AUTH-1001', message: '未登录' } } }

/** 打开 Run 弹窗并开始订阅 SSE（模拟 openRun 已完成）。 */
function openRunWithStream(h: ReturnType<typeof harness>) {
  h.app.openModal('Run run_1', '<div id="event-log"></div>', async () => {}, '关闭')
  h.modal.addEventListener('close', () => h.app.closeStream())
  h.app.listenRun('run_1', 'running')
  expect(h.modal.open).toBe(true)
  expect(h.sources).toHaveLength(1)
}

describe('AUTH-401-01 Run 弹窗开着、SSE 在跑时收到 401', () => {
  it('弹窗关闭、SSE 断开、登录页可见、提示一次「登录已过期，请重新登录」', async () => {
    const h = harness({ '/admin/api/runs/run_1': R401 })
    openRunWithStream(h)
    await h.app.syncRunFromRest(h.state.runView) // 后台重取（notify=false）
    expect(h.modal.open).toBe(false)
    expect(h.sources[0].closed).toBe(true)
    expect(h.state.runView).toBeNull()
    expect(h.state.eventSource).toBeNull()
    expect(h.loginVisible()).toBe(true)
    expect(h.appHidden()).toBe(true)
    expect(h.toasts()).toEqual([EXPIRED])
    expect(h.els['#toast'].className).toBe('toast error')
  })

  it('其他打开着的 <dialog> 也一起关掉', async () => {
    const h = harness({ '/admin/api/runs/run_1': R401 })
    openRunWithStream(h)
    h.otherDialog.showModal()
    await h.app.syncRunFromRest(h.state.runView)
    expect(h.otherDialog.open).toBe(false)
    expect(h.modal.open).toBe(false)
  })

  it('api() 抛出的错误带 status=401', async () => {
    const h = harness({ '/admin/api/x': R401 })
    const err = await h.app.api('/admin/api/x').catch((e: unknown) => e) as Error & { status?: number; code?: string }
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(401)
    expect(err.message).toBe('未登录')
  })

  it('同一轮里连续多个 401 只提示一次', async () => {
    const h = harness({ '/admin/api/a': R401, '/admin/api/b': R401, '/admin/api/runs/run_1': R401 })
    openRunWithStream(h)
    await Promise.all([h.app.api('/admin/api/a').catch(() => {}), h.app.api('/admin/api/b').catch(() => {}), h.app.syncRunFromRest(h.state.runView, { notify: true })])
    expect(h.toasts()).toEqual([EXPIRED])
  })
})

describe('AUTH-401-02 其他弹窗（应用编辑）提交时收到 401', () => {
  it('弹窗关闭、登录页可见，只有过期提示，不再叠加调用方自己的错误 toast', async () => {
    const h = harness({ '/admin/api/apps/app_1': R401 })
    h.app.openAppEdit('app_1')
    expect(h.modal.open).toBe(true)
    await h.submitModal({ name: 'A', status: 'active', scopes: 'agents:read', webhookUrl: '', webhookSecret: '' })
    expect(h.requests.some((r) => r.path === '/admin/api/apps/app_1' && r.method === 'PATCH')).toBe(true)
    expect(h.modal.open).toBe(false)
    expect(h.loginVisible()).toBe(true)
    expect(h.toasts()).toEqual([EXPIRED])
  })
})

describe('AUTH-401-03 重新登录后', () => {
  it('不再请求旧 Run 的 /events；旧流的回调不再触发请求', async () => {
    const h = harness({ '/admin/api/runs/run_1': R401, '/auth/local/login': { status: 200, body: { csrfToken: 'n', user: { name: 'A', role: 'r', dataScope: 'all' } } } })
    openRunWithStream(h)
    const old = h.sources[0]
    await h.app.syncRunFromRest(h.state.runView)
    h.state.session = { csrfToken: 'n', user: { name: 'A', role: 'r', dataScope: 'all' } } // 模拟重新登录成功
    await h.app.enterApp()
    const before = h.requests.length
    old.onerror?.()
    old.onopen?.()
    for (const f of old.listeners['run.completed'] ?? []) f({ data: JSON.stringify({ seq: 9, data: {} }) })
    await Promise.resolve()
    expect(h.requests.slice(before)).toEqual([])
    expect(h.requests.filter((r) => r.path === '/admin/api/runs/run_1/events')).toHaveLength(1)
    expect(h.sources).toHaveLength(1)
  })

  it('提示不重复：过期一次只提示一次；重新登录后再过期，会再提示一次', async () => {
    const h = harness({ '/admin/api/a': R401 })
    await h.app.api('/admin/api/a').catch(() => {})
    await h.app.api('/admin/api/a').catch(() => {})
    expect(h.toasts()).toEqual([EXPIRED])
    h.state.session = { csrfToken: 'n', user: { name: 'A', role: 'r', dataScope: 'all' } } // 模拟重新登录成功
    await h.app.enterApp()
    await h.app.api('/admin/api/a').catch(() => {})
    expect(h.toasts()).toEqual([EXPIRED, EXPIRED])
  })
})

describe('AUTH-401-04 403 和 5xx 不变', () => {
  for (const [status, code, message] of [[403, 'POL-2001', '没有权限'], [500, 'SYS-9001', '服务器内部错误'], [503, 'SYS-9002', '暂时不可用']] as const) {
    it(`${status}：不跳登录页、弹窗不关，走原来的 toast（带错误码）`, async () => {
      const h = harness({ '/admin/api/apps/app_1': { status, body: { error: { code, message } } } })
      h.app.openAppEdit('app_1')
      await h.submitModal({ name: 'A', status: 'active', scopes: 'agents:read', webhookUrl: '', webhookSecret: '' })
      expect(h.loginVisible()).toBe(false)
      expect(h.appHidden()).toBe(false)
      expect(h.modal.open).toBe(true)
      expect(h.toasts()).toEqual([`${message}（错误码 ${code}）`])
      expect(h.state.session).not.toBeNull()
    })
  }
})

describe('AUTH-401-05 登录与会话检查', () => {
  it('登录页输错密码收到 401：不出现过期提示，照旧显示失败原因', async () => {
    const h = harness({ '/auth/config': { status: 200, body: { localLogin: true } }, '/auth/session': R401, '/auth/local/login': { status: 401, body: { error: { code: 'AUTH-1002', message: '邮箱或密码错误' } } } })
    await h.app.init()
    expect(h.loginVisible()).toBe(true)
    expect(h.toasts()).toEqual([]) // 启动时会话检查 401：安静显示登录页
    const submit = h.els['#login-form'].listeners.submit[0]
    await submit({ preventDefault() {}, target: { _data: { email: 'a@b.c', password: 'wrong' } } })
    expect(h.toasts()).toEqual(['邮箱或密码错误'])
    expect(h.toasts()).not.toContain(EXPIRED)
    expect(h.loginVisible()).toBe(true)
  })

  it('启动时 /auth/session 返回 401：安静显示登录页，不弹过期提示', async () => {
    const h = harness({ '/auth/config': { status: 200, body: { localLogin: true } }, '/auth/session': R401 })
    await h.app.init()
    expect(h.loginVisible()).toBe(true)
    expect(h.toasts()).toEqual([])
    expect(h.switched()).toBe(0)
  })

  it('过期之后输错密码：提示的是失败原因，不是第二次过期提示', async () => {
    const h = harness({ '/auth/config': { status: 200, body: { localLogin: true } }, '/auth/session': { status: 200, body: { csrfToken: 'c', user: { name: 'A', role: 'r', dataScope: 'all' } } }, '/admin/api/a': R401, '/auth/local/login': { status: 401, body: { error: { code: 'AUTH-1002', message: '邮箱或密码错误' } } } })
    await h.app.init()
    await h.app.api('/admin/api/a').catch(() => {})
    const submit = h.els['#login-form'].listeners.submit[0]
    await submit({ preventDefault() {}, target: { _data: { email: 'a@b.c', password: 'wrong' } } })
    expect(h.toasts()).toEqual([EXPIRED, '邮箱或密码错误'])
  })
})
