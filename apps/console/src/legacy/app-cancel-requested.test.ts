import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * push 6：cancel 新约定——批准之后再 cancel 一律接受，返回原来的 200（请求已接受，当前步骤结束后停止），
 * Run 上记取消标记，当前这次工具调用结束后才停下（未结束的 Run 不再返回 409；已结束的 Run 照旧 409 RUN-7005）。
 * 旧版控制台 app.cancelRun：
 * - 任何 2xx：提示「已请求取消，当前步骤结束后停止」，刷新运行列表；
 *   Run 详情弹窗开着且是这条 Run 时，不关弹窗，按 REST 刷新弹窗里的 Run（SSE 继续等 run.cancelled）。
 * - 失败：照旧 toast(errorText(error), "error")，不显示成功提示，不刷新。
 */
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const REQUESTED = '已请求取消，当前步骤结束后停止'

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
  add(c: string) { this.s.add(c) }
  remove(c: string) { this.s.delete(c) }
  contains(c: string) { return this.s.has(c) }
}
class El {
  innerHTML = ''
  className = ''
  classList = new ClassList()
  onclick: unknown = null
  private _text = ''
  history: string[] = []
  get textContent() { return this._text }
  set textContent(v: string) { this._text = v; this.history.push(v) }
  addEventListener() {}
}
class Dialog extends El {
  open = true
  close() { this.open = false }
}

const RUN_ID = 'run_01M5PK6G1GPZ3APBN3QNXR'
type Resp = { status: number; body?: unknown } | 'offline'
const runBody = (status: string) => ({ id: RUN_ID, status, costUsd: 0, messages: [], toolCalls: [] })
const LIST = '/admin/api/runs?limit=100'
const CANCEL = `/admin/api/runs/${RUN_ID}/cancel`
const DETAIL = `/admin/api/runs/${RUN_ID}`

function harness(routes: Record<string, Resp>, { modalRunId }: { modalRunId?: string } = {}) {
  const modal = new Dialog()
  modal.open = Boolean(modalRunId)
  const els: Record<string, El> = { '#modal': modal, '#toast': new El(), '#content': new El() }
  if (modalRunId) for (const id of ['#run-toolbar', '#run-stream', '#run-messages', '#run-tools']) els[id] = new El()
  const calls: string[] = []
  const fetch = async (path: string, init: { method: string }) => {
    calls.push(`${init.method} ${path}`)
    const resp = routes[path] ?? { status: 404, body: { error: { code: 'X-404', message: 'not found' } } }
    if (resp === 'offline') throw new TypeError('Failed to fetch')
    return { status: resp.status, ok: resp.status >= 200 && resp.status < 300, text: async () => (resp.body === undefined ? '' : JSON.stringify(resp.body)) }
  }
  const view = modalRunId ? { runId: modalRunId, source: null, attempts: 0, link: 'live', finished: false, sync: 0 } : null
  const state: Record<string, unknown> = { session: { permissions:['*'], csrfToken: 'c' }, tab: 'runs', runs: [], runView: view, eventSource: null }
  const deps: Record<string, unknown> = {
    $: (sel: string) => els[sel] ?? null, fetch, state,
    setTimeout: () => 0, clearTimeout: () => {},
    handleSessionExpired: () => {}, showLogin: () => {},
    idSeg: (s: string) => encodeURIComponent(s), fmt: (v: unknown) => String(v ?? '—'),
  }
  const names = Object.keys(deps)
  const consts = ['RUN_TERMINAL_EVENTS', 'RUN_ACTIVE_STATUSES', 'STREAM_MAX_RETRIES', 'RUN_APPROVAL_EXPIRED_CODE', 'RUN_APPROVAL_EXPIRED_TEXT'].map(constLine).join('\n')
  const fns = ['canPermission', 'esc', 'toast', 'errorText', 'api', 'empty', 'statusPill', 'renderRuns', 'runMessagesHtml', 'runToolsHtml', 'runToolbarHtml',
    'renderRunView', 'renderStreamStatus', 'syncRunFromRest', 'endRunStream', 'closeStream']
  const optional = ['runFailureText'].filter(hasFn)
  const src = `${consts}\n${[...fns, ...optional].map(fnSource).join('\n')}\nreturn { ${method('cancelRun')} };`
  const app = new Function(...names, src)(...names.map((n) => deps[n])) as { cancelRun(id: string): Promise<void> }
  return { app, els, modal, calls, toasts: () => els['#toast'].history, toastKind: () => els['#toast'].className }
}

const LIST_OK: Resp = { status: 200, body: { items: [{ id: RUN_ID, agentName: 'Bot', status: 'running', triggerType: 'api', costUsd: 0, createdAt: null }] } }

describe('旧版 cancelRun：200「已请求取消」', () => {
  it('列表里点取消，返回 200：提示「已请求取消，当前步骤结束后停止」，刷新运行列表', async () => {
    const h = harness({ [CANCEL]: { status: 200, body: { id: RUN_ID, status: 'running' } }, [LIST]: LIST_OK })
    await h.app.cancelRun(RUN_ID)
    expect(h.toasts()).toEqual([REQUESTED])
    expect(h.toastKind()).toBe('toast ok')
    expect(h.calls).toEqual([`POST ${CANCEL}`, `GET ${LIST}`])
    expect(h.els['#content'].innerHTML).toContain('运行中心')
    expect(h.els['#content'].innerHTML).toContain(RUN_ID)
  })

  it('返回 200 也按成功处理，文案相同', async () => {
    const h = harness({ [CANCEL]: { status: 200, body: { id: RUN_ID, status: 'cancelled' } }, [LIST]: LIST_OK })
    await h.app.cancelRun(RUN_ID)
    expect(h.toasts()).toEqual([REQUESTED])
    expect(h.calls).toContain(`GET ${LIST}`)
  })

  it('200 响应体为空也按成功处理', async () => {
    const h = harness({ [CANCEL]: { status: 200 }, [LIST]: LIST_OK })
    await h.app.cancelRun(RUN_ID)
    expect(h.toasts()).toEqual([REQUESTED])
    expect(h.calls).toContain(`GET ${LIST}`)
  })

  it('Run 弹窗开着（同一条 Run）：不关弹窗，按 REST 刷新弹窗里的 Run，并刷新列表', async () => {
    const h = harness({ [CANCEL]: { status: 200, body: {} }, [DETAIL]: { status: 200, body: runBody('running') }, [LIST]: LIST_OK }, { modalRunId: RUN_ID })
    await h.app.cancelRun(RUN_ID)
    expect(h.toasts()).toEqual([REQUESTED])
    expect(h.modal.open).toBe(true)
    expect(h.calls).toContain(`GET ${DETAIL}`)
    expect(h.calls).toContain(`GET ${LIST}`)
    expect(h.calls[0]).toBe(`POST ${CANCEL}`)
    expect(h.els['#run-toolbar'].innerHTML).toContain('运行中')
  })

  it('Run 弹窗里刷新到已取消：状态栏显示 cancelled，不再有「取消 Run」按钮', async () => {
    const h = harness({ [CANCEL]: { status: 200, body: {} }, [DETAIL]: { status: 200, body: runBody('cancelled') }, [LIST]: LIST_OK }, { modalRunId: RUN_ID })
    await h.app.cancelRun(RUN_ID)
    expect(h.modal.open).toBe(true)
    expect(h.els['#run-toolbar'].innerHTML).toContain('已取消')
    expect(h.els['#run-toolbar'].innerHTML).not.toContain('取消 Run')
  })
})

describe('旧版 cancelRun：失败照旧弹错误 toast', () => {
  it('500：错误 toast 带错误码，不显示成功提示，不刷新', async () => {
    const h = harness({ [CANCEL]: { status: 500, body: { error: { code: 'SYS-9001', message: '服务器内部错误' } } }, [LIST]: LIST_OK })
    await h.app.cancelRun(RUN_ID)
    expect(h.toasts()).toEqual(['服务器内部错误（错误码 SYS-9001）'])
    expect(h.toastKind()).toBe('toast error')
    expect(h.calls).toEqual([`POST ${CANCEL}`])
  })

  it('404：错误 toast 带错误码', async () => {
    const h = harness({ [CANCEL]: { status: 404, body: { error: { code: 'RUN-7001', message: 'Run 不存在' } } } })
    await h.app.cancelRun(RUN_ID)
    expect(h.toasts()).toEqual(['Run 不存在（错误码 RUN-7001）'])
    expect(h.toastKind()).toBe('toast error')
  })

  it('断网：显示「网络连接失败（错误码 NET-0001）」', async () => {
    const h = harness({ [CANCEL]: 'offline' })
    await h.app.cancelRun(RUN_ID)
    expect(h.toasts()).toEqual(['网络连接失败（错误码 NET-0001）'])
    expect(h.toastKind()).toBe('toast error')
  })

  it('弹窗开着时失败：弹窗保持打开', async () => {
    const h = harness({ [CANCEL]: { status: 500, body: { error: { code: 'SYS-9001', message: '服务器内部错误' } } } }, { modalRunId: RUN_ID })
    await h.app.cancelRun(RUN_ID)
    expect(h.modal.open).toBe(true)
    expect(h.toastKind()).toBe('toast error')
  })

  it('源码里不再有旧文案「取消请求已提交」', () => {
    expect(method('cancelRun')).not.toContain('取消请求已提交')
    expect(method('cancelRun')).toContain('toast(errorText(error), "error")')
  })
})
