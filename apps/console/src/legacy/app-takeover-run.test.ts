import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * R9：旧版 Run 弹窗里的 Worker 接手相关显示。
 * - SSE tool.interrupted：事件日志写一行可读记录，不显示参数和结果；
 *   attempt = 被中断那次执行的序号（从 1 开始）。action=rerun「工具 X 执行中断，已自动重跑（第 attempt+1 次）」，
 *   action=confirm「工具 X 第 attempt 次执行被中断，需重新确认」；attempt 不是正整数时不写次数。
 * - Run 失败原因：REST 的 errorCode / errorMessage 显示在状态栏；SSE run.failed 的 data.error.code 显示在事件日志。
 *   APR-2102 显示专门文案「审批已过期，Run 已终止」；其他码（如 CFG-8504 env 引用）照旧显示后端原文 + 错误码。
 * - 所有字段转义，不拼出 HTML；新代码没有内联 style / on*。
 */
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const EXPIRED_TEXT = '审批已过期，Run 已终止'

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

class El {
  innerHTML = ''
  className = ''
  scrollTop = 0
  scrollHeight = 0
  children: El[] = []
  onclick: ((e: unknown) => void) | null = null
  private listeners: Record<string, ((e?: unknown) => void)[]> = {}
  set textContent(v: string) { this.innerHTML = String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); this.children = [] }
  get textContent() { return this.innerHTML.replace(/<[^>]*>/g, '') }
  appendChild(c: El) { this.children.push(c); return c }
  addEventListener(t: string, f: (e?: unknown) => void) { (this.listeners[t] ??= []).includes(f) || this.listeners[t].push(f) }
  dispatch(t: string) { for (const f of this.listeners[t] ?? []) f({}) }
  close() { this.dispatch('close') }
}

class FakeES {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  static instances: FakeES[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private listeners: Record<string, ((e: { data: string }) => void)[]> = {}
  constructor(public url: string) { FakeES.instances.push(this) }
  addEventListener(t: string, f: (e: { data: string }) => void) { (this.listeners[t] ??= []).push(f) }
  close() { this.readyState = 2 }
  emit(type: string, seq: number, data: unknown) { for (const f of this.listeners[type] ?? []) f({ data: JSON.stringify({ type, seq, data }) }) }
}

const RUN_ID = 'run_01M5PK6G1GPZ3APBN3QNXR'
type Run = { id: string; status: string; costUsd: number; messages: unknown[]; toolCalls: unknown[]; errorCode?: string | null; errorMessage?: string | null }
const run = (status: string, over: Partial<Run> = {}): Run => ({ id: RUN_ID, status, costUsd: 0, messages: [], toolCalls: [], ...over })
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function harness(initial: Run) {
  FakeES.instances = []
  const els: Record<string, El> = {}
  const responses: unknown[] = []
  const modal = new El()
  let bodyHtml = ''
  const state: Record<string, unknown> = { eventSource: null, runView: null }
  const deps: Record<string, unknown> = {
    state,
    $: (sel: string) => (sel === '#modal' ? modal : els[sel.replace(/^#/, '')] ?? null),
    document: { createElement: () => new El() },
    EventSource: FakeES,
    api: async () => (responses.length ? responses.shift() : initial),
    openModal: (_t: string, body: string) => {
      bodyHtml = body
      for (const k of Object.keys(els)) delete els[k]
      for (const m of body.matchAll(/id="([^"]+)"/g)) els[m[1]] = new El()
    },
    toast: () => {},
    errorText: (e: Error) => e.message,
    statusPill: (s: string) => `<span class="pill">${s}</span>`,
  }
  const names = Object.keys(deps)
  const consts = ['RUN_TERMINAL_EVENTS', 'RUN_ACTIVE_STATUSES', 'STREAM_MAX_RETRIES', 'RUN_APPROVAL_EXPIRED_CODE', 'RUN_APPROVAL_EXPIRED_TEXT'].map(constLine).join('\n')
  const fns = ['isEntityId', 'idSeg', 'esc', 'runMessagesHtml', 'runToolsHtml', 'runToolbarHtml', 'renderRunView', 'renderStreamStatus', 'listenRun', 'connectRunStream', 'syncRunFromRest', 'endRunStream', 'closeStream']
  const optional = ['runFailureText', 'toolInterruptedText', 'runEventText'].filter(hasFn)
  const body = `${consts}\n${[...fns, ...optional].map(fnSource).join('\n')}\nreturn { ${method('openRun')} };`
  const app = new Function(...names, body)(...names.map((n) => deps[n])) as { openRun(id: string): Promise<void> }
  return {
    app, els,
    reply: (...r: unknown[]) => { responses.push(...r) },
    es: () => FakeES.instances.at(-1)!,
    /** 状态栏：REST 同步重渲染后读 #run-toolbar，否则读打开弹窗时的初始 HTML。 */
    toolbar: () => els['run-toolbar']?.innerHTML || bodyHtml,
    log: () => (els['event-log']?.children ?? []).map((c) => c.innerHTML),
  }
}

async function opened(initial = run('running')) {
  const h = harness(initial)
  await h.app.openRun(RUN_ID)
  return h
}

describe('R9 SSE tool.interrupted', () => {
  it('action=rerun、attempt=1：重跑是第 2 次「工具 X 执行中断，已自动重跑（第 2 次）」', async () => {
    const h = await opened()
    h.es().emit('tool.interrupted', 5, { toolCallId: 'tc_1', tool: 'web_fetch', action: 'rerun', attempt: 1, approvalId: null, previousApprovalId: null })
    expect(h.log()).toHaveLength(1)
    expect(h.log()[0]).toContain('工具 web_fetch 执行中断，已自动重跑（第 2 次）')
    expect(h.log()[0]).not.toContain('第 1 次')
    expect(h.log()[0]).toContain('tool.interrupted')
    expect(h.log()[0]).not.toContain('toolCallId')
  })

  it('action=rerun、attempt=3：「已自动重跑（第 4 次）」', async () => {
    const h = await opened()
    h.es().emit('tool.interrupted', 5, { toolCallId: 'tc_1', tool: 'web_fetch', action: 'rerun', attempt: 3, approvalId: null, previousApprovalId: null })
    expect(h.log()[0]).toContain('工具 web_fetch 执行中断，已自动重跑（第 4 次）')
  })

  it('action=rerun、attempt=null：不写次数', async () => {
    const h = await opened()
    h.es().emit('tool.interrupted', 5, { toolCallId: 'tc_1', tool: 'web_fetch', action: 'rerun', attempt: null })
    expect(h.log()[0]).toContain('工具 web_fetch 执行中断，已自动重跑')
    expect(h.log()[0]).not.toContain('（第')
  })

  it('action=confirm、attempt=3：「工具 X 第 3 次执行被中断，需重新确认」（不加 1）', async () => {
    const h = await opened()
    h.es().emit('tool.interrupted', 6, { toolCallId: 'tc_2', tool: 'send_mail', action: 'confirm', attempt: 3, approvalId: 'apr_1', previousApprovalId: 'apr_0' })
    expect(h.log()[0]).toContain('工具 send_mail 第 3 次执行被中断，需重新确认')
    expect(h.log()[0]).not.toContain('apr_1')
  })

  it('action=confirm、attempt=1：「工具 X 第 1 次执行被中断，需重新确认」', async () => {
    const h = await opened()
    h.es().emit('tool.interrupted', 6, { toolCallId: 'tc_2', tool: 'send_mail', action: 'confirm', attempt: 1 })
    expect(h.log()[0]).toContain('工具 send_mail 第 1 次执行被中断，需重新确认')
  })

  it('action=confirm、attempt 非正整数：「工具 X 执行被中断，需重新确认」，不写次数', async () => {
    const h = await opened()
    h.es().emit('tool.interrupted', 6, { toolCallId: 'tc_2', tool: 'send_mail', action: 'confirm', attempt: 0 })
    expect(h.log()[0]).toContain('工具 send_mail 执行被中断，需重新确认')
    expect(h.log()[0]).not.toContain('第 ')
  })

  it('不显示参数和结果（即使事件里意外带了）', async () => {
    const h = await opened()
    h.es().emit('tool.interrupted', 7, { toolCallId: 'tc_3', tool: 'send_mail', action: 'confirm', attempt: 1, args: { to: 'secret@x' }, result: 'RESULT-XYZ' })
    expect(h.log()[0]).not.toContain('secret@x')
    expect(h.log()[0]).not.toContain('RESULT-XYZ')
  })

  it('XSS：工具名被转义；非整数 attempt 不显示次数', async () => {
    const h = await opened()
    h.es().emit('tool.interrupted', 8, { toolCallId: 'tc_4', tool: '<img src=x onerror=alert(1)>', action: 'rerun', attempt: '<b>2</b>' })
    expect(h.log()[0]).not.toContain('<img')
    expect(h.log()[0]).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(h.log()[0]).not.toContain('<b>')
    expect(h.log()[0]).not.toContain('（第')
  })

  it('其他事件照旧显示 JSON', async () => {
    const h = await opened()
    h.es().emit('tool.started', 9, { toolCallId: 'tc_5', tool: 'echo' })
    expect(h.log()[0]).toContain('{&quot;toolCallId&quot;:&quot;tc_5&quot;')
  })
})

describe('R9 Run 失败原因：REST errorCode / errorMessage', () => {
  it('APR-2102：状态栏显示「审批已过期，Run 已终止」+ 错误码', async () => {
    const h = await opened(run('failed', { errorCode: 'APR-2102', errorMessage: '后端原文' }))
    expect(h.toolbar()).toContain(`失败原因：${EXPIRED_TEXT}（错误码 APR-2102）`)
    expect(h.toolbar()).not.toContain('后端原文')
  })

  it('护栏：CFG-8504 仍是 env 引用的原文案，不会被显示成审批过期', async () => {
    const h = await opened(run('failed', { errorCode: 'CFG-8504', errorMessage: '不支持 env: 引用' }))
    expect(h.toolbar()).toContain('失败原因：不支持 env: 引用（错误码 CFG-8504）')
    expect(h.toolbar()).not.toContain(EXPIRED_TEXT)
  })

  it('其他失败码：后端原文 + 错误码；没有 message 时用「Run 执行失败」', async () => {
    const h = await opened(run('failed', { errorCode: 'MDL-3001', errorMessage: null }))
    expect(h.toolbar()).toContain('失败原因：Run 执行失败（错误码 MDL-3001）')
  })

  it('没有错误或 Run 进行中：不显示失败原因', async () => {
    expect((await opened(run('succeeded'))).toolbar()).not.toContain('失败原因')
    expect((await opened(run('running', { errorCode: 'X-1' }))).toolbar()).not.toContain('失败原因')
  })

  it('XSS：errorMessage / errorCode 被转义', async () => {
    const h = await opened(run('failed', { errorCode: '<i>X</i>', errorMessage: '<img src=x onerror=1>' }))
    expect(h.toolbar()).not.toContain('<img')
    expect(h.toolbar()).not.toContain('<i>')
  })
})

describe('R9 Run 失败原因：SSE run.failed data.error.code', () => {
  it('APR-2102：事件日志显示专门文案，随后 REST 同步把状态栏更新为失败原因', async () => {
    const h = await opened()
    h.reply(run('failed', { errorCode: 'APR-2102', errorMessage: EXPIRED_TEXT }))
    h.es().emit('run.failed', 10, { status: 'failed', output: null, error: { code: 'APR-2102', message: '后端原文' } })
    expect(h.log()[0]).toContain(`${EXPIRED_TEXT}（错误码 APR-2102）`)
    expect(h.log()[0]).not.toContain('后端原文')
    await flush()
    expect(h.toolbar()).toContain(`失败原因：${EXPIRED_TEXT}（错误码 APR-2102）`)
  })

  it('护栏：run.failed 里的 CFG-8504 照旧显示 env 引用原文', async () => {
    const h = await opened()
    h.es().emit('run.failed', 10, { status: 'failed', output: null, error: { code: 'CFG-8504', message: '不支持 env: 引用' } })
    expect(h.log()[0]).toContain('不支持 env: 引用（错误码 CFG-8504）')
    expect(h.log()[0]).not.toContain(EXPIRED_TEXT)
  })
})

describe('R9 常量只定义一处', () => {
  it('APR-2102 只在 RUN_APPROVAL_EXPIRED_CODE 一行；APR-2104 / APR-2103 / RUN-7005 只在 APPROVAL_STALE_CODES 一行（RUN-7005 另用于选文案）；不碰 CFG-8503 / CFG-8504', () => {
    expect(APP.match(/APR-2102/g)).toHaveLength(1)
    expect(constLine('RUN_APPROVAL_EXPIRED_CODE')).toBe('const RUN_APPROVAL_EXPIRED_CODE = "APR-2102";')
    expect(APP.match(/"APR-2104"/g)).toHaveLength(1)
    expect(APP.match(/"APR-2103"/g)).toHaveLength(1)
    expect(constLine('APPROVAL_STALE_CODES')).toBe('const APPROVAL_STALE_CODES = new Set(["APR-2104", "APR-2103", "RUN-7005"]);')
    expect(constLine('APPROVAL_RUN_FINISHED_TEXT')).toBe('const APPROVAL_RUN_FINISHED_TEXT = "Run 已结束，此审批已失效";')
    expect(APP).not.toMatch(/"CFG-8503"/)
    expect(APP).not.toMatch(/CFG-8504/)
  })
})

describe('R9 严格 CSP', () => {
  it('新增的 Run 渲染代码没有 style= 和 on*= 属性', () => {
    const src = ['runFailureText', 'toolInterruptedText', 'runEventText'].map(fnSource).join('\n')
    expect(src).not.toMatch(/style=/)
    expect(src).not.toMatch(/\son[a-z]+="/)
  })
})

describe('R9 SSE tool.interrupted：attempt 非法值不显示次数', () => {
  const BAD: Array<[string, unknown]> = [['0', 0], ['null', null], ['负数', -1], ['小数', 1.5], ['字符串', '2']]

  it.each(BAD)('action=confirm、attempt=%s：「工具 X 执行被中断，需重新确认」，不写次数', async (_label, attempt) => {
    const h = await opened()
    h.es().emit('tool.interrupted', 6, { toolCallId: 'tc_2', tool: 'send_mail', action: 'confirm', attempt })
    expect(h.log()).toHaveLength(1)
    expect(h.log()[0]).toContain('工具 send_mail 执行被中断，需重新确认')
    expect(h.log()[0]).not.toContain('第 ')
    expect(h.log()[0]).not.toContain('NaN')
  })

  it.each(BAD)('action=rerun、attempt=%s：「工具 X 执行中断，已自动重跑」，不写次数', async (_label, attempt) => {
    const h = await opened()
    h.es().emit('tool.interrupted', 5, { toolCallId: 'tc_1', tool: 'web_fetch', action: 'rerun', attempt })
    expect(h.log()).toHaveLength(1)
    expect(h.log()[0]).toContain('工具 web_fetch 执行中断，已自动重跑')
    expect(h.log()[0]).not.toContain('（第')
    expect(h.log()[0]).not.toContain('NaN')
  })
})
