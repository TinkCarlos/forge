import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * FE-R7 P3：旧版控制台「刷新」类按钮（顶栏 #refresh、加载失败卡片的「重试」、运行中心/待审批的「刷新」，
 * 后两者是 onclick="app.renderCurrent()"）以及「新增角色」（onclick="app.openRole()"）
 * 失败时不能留下未捕获的 Promise rejection：
 * - 401（会话过期）：handleSessionExpired 已提示过一次，这里静默（errorText 返回空，toast 不弹）。
 * - 其他错误（500 等）：照常弹错误 toast（带错误码），不能被吞。
 * - 正常时行为不变。
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
  classList: ClassList
  private _text = ''
  history: string[] = []
  listeners: Record<string, ((e?: unknown) => unknown)[]> = {}
  constructor(cls = '') { this.classList = new ClassList(cls) }
  get textContent() { return this._text }
  set textContent(v: string) { this._text = v; this.history.push(v) }
  addEventListener(t: string, f: (e?: unknown) => unknown) { (this.listeners[t] ??= []).push(f) }
  querySelector() { return null }
  querySelectorAll() { return [] as El[] }
}
class Dialog extends El {
  open = false
  showModal() { this.open = true }
  close() { this.open = false }
}

type Resp = { status: number; body?: unknown }
const SESSION = { permissions:['*'], csrfToken: 'c', user: { name: 'A', role: 'platform_admin', dataScope: 'all' } }

function harness(routes: Record<string, Resp>) {
  const modal = new Dialog()
  const els: Record<string, El> = {
    '#modal': modal, '#modal-title': new El(), '#modal-body': new El(), '#modal-submit': new El(), '#modal-form': new El(),
    '#login-view': new El('login-shell hidden'), '#app-view': new El('app-shell'), '#toast': new El('toast hidden'),
    '#login-form': new El(), '#sso-login': new El('hidden'), '#login-hint': new El(), '#logout': new El(), '#refresh': new El(),
    '#user-chip': new El(), '#content': new El(), '#page-title': new El(), '#page-subtitle': new El(),
  }
  const $ = (sel: string) => els[sel] ?? null
  const document = { querySelectorAll: (sel: string) => (sel === 'dialog[open]' ? [modal].filter((d) => d.open) : []) }
  const fetch = async (path: string) => {
    const resp = routes[path] ?? { status: 200, body: {} }
    return { status: resp.status, ok: resp.status >= 200 && resp.status < 300, text: async () => (resp.body === undefined ? '' : JSON.stringify(resp.body)) }
  }
  const state: Record<string, unknown> = { session: null, tab: 'runs', runs: [], runView: null, eventSource: null }
  const deps: Record<string, unknown> = { bindConfigurationFields: () => {},
    $, document, fetch, state,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    window: { addEventListener: () => {} }, location: { hash: '' },
    bindAgentActions: () => {}, onHashChange: () => {}, checkHealth: () => {}, renderNav: () => {}, switchTab: async () => {},
    idSeg: (s: string) => encodeURIComponent(s), fmt: (v: unknown) => String(v ?? '—'),
  }
  const names = Object.keys(deps)
  const fnNames = ['canPermission', 'esc', 'errorText', 'toast', 'api', 'handleSessionExpired', 'showLogin', 'showApp', 'init', 'enterApp', 'renderCurrent',
    'field', 'textarea', 'select', 'permissionName', 'permissionFields', 'renderRuns', 'empty', 'statusPill', 'openModal', 'endRunStream', 'closeStream']
  const optional = ['refreshCurrent'].filter(hasFn)
  const src = `${constLine('SESSION_EXPIRED_TEXT')}\n${constLine('PERMISSION_DOMAINS')}\n${constLine('PERMISSION_ACTIONS')}\n${[...fnNames, ...optional].map(fnSource).join('\n')}\nreturn { init, ${method('openRole')} };`
  const app = new Function(...names, src)(...names.map((n) => deps[n])) as {
    init(): Promise<void>
    openRole(): unknown
  }
  /** 模拟浏览器点击：只调用处理函数，不 await、不处理它的返回值（浏览器也不会）。 */
  const clickRefresh = () => { for (const f of els['#refresh'].listeners.click ?? []) f() }
  return {
    app, els, modal, state, clickRefresh,
    toasts: () => els['#toast'].history,
    loginVisible: () => !els['#login-view'].classList.contains('hidden'),
  }
}

const OK_ROUTES: Record<string, Resp> = {
  '/auth/config': { status: 200, body: { localLogin: true } },
  '/auth/session': { status: 200, body: SESSION },
}
const R401 = { status: 401, body: { error: { code: 'AUTH-1001', message: '未登录' } } }
const R500 = { status: 500, body: { error: { code: 'SYS-9001', message: '服务器内部错误' } } }

let unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
// 让挂起的 rejection 有机会被判定为「未处理」（Node 在微任务清空后的下一轮触发 unhandledRejection）。
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }

beforeEach(() => { unhandled = []; process.on('unhandledRejection', onUnhandled) })
afterEach(() => { process.off('unhandledRejection', onUnhandled) })

describe('顶栏 #refresh', () => {
  it('401：没有未捕获的 rejection，登录页可见，过期提示只一次', async () => {
    const h = harness({ ...OK_ROUTES, '/admin/api/runs?limit=100': R401 })
    await h.app.init()
    h.clickRefresh()
    await settle()
    expect(unhandled).toEqual([])
    expect(h.loginVisible()).toBe(true)
    expect(h.toasts()).toEqual([EXPIRED])
  })

  it('401 后连点多次：仍然没有未捕获的 rejection，过期提示仍只一次', async () => {
    const h = harness({ ...OK_ROUTES, '/admin/api/runs?limit=100': R401 })
    await h.app.init()
    for (let i = 0; i < 4; i++) h.clickRefresh()
    await settle()
    expect(unhandled).toEqual([])
    expect(h.toasts()).toEqual([EXPIRED])
  })

  it('500：弹一条带错误码的错误 toast，不跳登录页，没有未捕获的 rejection', async () => {
    const h = harness({ ...OK_ROUTES, '/admin/api/runs?limit=100': R500 })
    await h.app.init()
    h.clickRefresh()
    await settle()
    expect(unhandled).toEqual([])
    expect(h.toasts()).toEqual(['服务器内部错误（错误码 SYS-9001）'])
    expect(h.els['#toast'].className).toBe('toast error')
    expect(h.loginVisible()).toBe(false)
  })

  it('正常：照常重新渲染当前页，不弹 toast', async () => {
    const h = harness({ ...OK_ROUTES, '/admin/api/runs?limit=100': { status: 200, body: { items: [{ id: 'run_1', agentName: 'Bot', status: 'succeeded', triggerType: 'api', costUsd: 0, createdAt: null }] } } })
    await h.app.init()
    h.clickRefresh()
    await settle()
    expect(unhandled).toEqual([])
    expect(h.toasts()).toEqual([])
    expect(h.els['#content'].innerHTML).toContain('run_1')
    expect(h.els['#content'].innerHTML).toContain('运行中心')
    expect(h.loginVisible()).toBe(false)
  })
})

describe('内联 onclick="app.renderCurrent()"（重试 / 运行中心、待审批的刷新）', () => {
  it('app.renderCurrent 指向带 catch 的 refreshCurrent，和 #refresh 走同一个函数', () => {
    expect(APP).toMatch(/^ {2}renderCurrent: refreshCurrent,$/m)
    expect(APP).toMatch(/\$\("#refresh"\)\.addEventListener\("click", \(\) => refreshCurrent\(\)\);/)
  })
})

describe('内联 onclick="app.openRole()"', () => {
  it('401：没有未捕获的 rejection，过期提示只一次', async () => {
    const h = harness({ ...OK_ROUTES, '/admin/api/roles': R401 })
    await h.app.init()
    h.app.openRole()
    await settle()
    expect(unhandled).toEqual([])
    expect(h.toasts()).toEqual([EXPIRED])
  })

  it('500：弹错误 toast，没有未捕获的 rejection', async () => {
    const h = harness({ ...OK_ROUTES, '/admin/api/roles': R500 })
    await h.app.init()
    h.app.openRole()
    await settle()
    expect(unhandled).toEqual([])
    expect(h.toasts()).toEqual(['服务器内部错误（错误码 SYS-9001）'])
  })

  it('正常：打开角色编辑弹窗', async () => {
    const h = harness({ ...OK_ROUTES, '/admin/api/roles': { status: 200, body: { catalog: [{ key:'agent.view', domain:'agent' }] } } })
    await h.app.init()
    h.app.openRole()
    await settle()
    expect(unhandled).toEqual([])
    expect(h.modal.open).toBe(true)
    expect(h.els['#modal-body'].innerHTML).toContain('agent.view')
    expect(h.toasts()).toEqual([])
  })
})
