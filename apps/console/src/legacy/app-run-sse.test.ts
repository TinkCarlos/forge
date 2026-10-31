import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * FE-R5：旧版 Run 弹窗消费 SSE 新契约（不再有 message.delta，只有打码后的 message.completed 和 run.* 等事件）。
 * - message.completed 事件里只有 { text, usage }，没有消息 id / role，所以收到后重取 GET /admin/api/runs/:id，
 *   以 REST 的 messages（按 id 渲染）整体重渲染消息区：同 id 覆盖、新 id 追加，前端不拼内容、不去重。
 * - run.* 结束事件：关流、重取 REST、以 REST 为准渲染状态和消息区，「生成中…」移除。
 * - 断线：只靠浏览器 EventSource 自带的重连（自动带 Last-Event-ID，服务端只认这个 header），最多 3 次；
 *   重连成功后用 REST 整体重渲染；超过上限或浏览器放弃（CLOSED）显示「连接已断开，点此刷新」，点击重取 REST。
 * - 「生成中…」只在连接正常、未收到结束事件时显示；重连中 / 断开时显示对应状态。
 * - 弹窗关闭必须关流，之后旧连接的事件和迟到的 REST 响应都不再生效。
 */
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')

function fnSource(name: string): string {
  const m = APP.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!m) throw new Error(`function ${name} not found in app.js`)
  return m[0]
}
function constSource(name: string): string {
  const m = APP.match(new RegExp(`^const ${name} = [^\\n]*;$`, 'm'))
  if (!m) throw new Error(`const ${name} not found in app.js`)
  return m[0]
}
function method(name: string): string {
  const m = APP.match(new RegExp(`^  (?:async )?${name}\\([^)]*\\) \\{[\\s\\S]*?^  \\},?$`, 'm'))
  if (!m) throw new Error(`method ${name} not found in app.js`)
  return m[0].replace(/,$/, '')
}

class El {
  open = false
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
  dispatch(t: string) { for (const f of this.listeners[t] ?? []) f({ type: t }) }
  close() { this.open = false; this.dispatch('close') }
}

class FakeES {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  static instances: FakeES[] = []
  readyState = 0
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private listeners: Record<string, ((e: { data: string; lastEventId: string }) => void)[]> = {}
  constructor(public url: string) { FakeES.instances.push(this) }
  addEventListener(t: string, f: (e: { data: string; lastEventId: string }) => void) { (this.listeners[t] ??= []).push(f) }
  close() { this.closed = true; this.readyState = 2 }
  open() { this.readyState = 1; this.onopen?.() }
  emit(type: string, seq: number, data: unknown) { for (const f of this.listeners[type] ?? []) f({ data: JSON.stringify({ type, seq, data }), lastEventId: String(seq) }) }
  fail(readyState = 0) { this.readyState = readyState; this.onerror?.() }
}

const RUN_ID = 'run_01M5PK6G1GPZ3APBN3QNXR'
const msg = (id: string, seq: number, role: string, text: string) => ({ id, seq, role, content: { text } })
const run = (status: string, messages: unknown[]) => ({ id: RUN_ID, status, costUsd: 0, messages, toolCalls: [] })
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function harness(initial: ReturnType<typeof run>) {
  FakeES.instances = []
  const els: Record<string, El> = {}
  const calls: string[] = []
  const toasts: string[] = []
  const responses: unknown[] = []
  let pending: ((v: unknown) => void)[] = []
  let deferred = false
  const modal = new El()
  const state: Record<string, unknown> = { eventSource: null, runView: null }
  const deps: Record<string, unknown> = {
    state,
    $: (sel: string) => (sel === '#modal' ? modal : els[sel.replace(/^#/, '')] ?? null),
    document: { createElement: () => new El() },
    EventSource: FakeES,
    api: async (path: string) => {
      calls.push(path)
      if (deferred) return new Promise((r) => pending.push(r))
      if (!responses.length) return initial
      const r = responses.shift()
      return typeof r === 'function' ? (r as () => unknown)() : r
    },
    openModal: (_t: string, body: string) => {
      modal.open = true
      for (const k of Object.keys(els)) delete els[k]
      for (const m of body.matchAll(/id="([^"]+)"/g)) els[m[1]] = new El()
      els['__body'] = Object.assign(new El(), { innerHTML: body })
    },
    toast: (m: string) => { toasts.push(m) },
    errorText: (e: Error) => e.message,
    statusPill: (s: string) => `<span class="pill">${s}</span>`,
    json: (v: unknown) => JSON.stringify(v),
  }
  const names = Object.keys(deps)
  const consts = ['RUN_TERMINAL_EVENTS', 'RUN_ACTIVE_STATUSES', 'STREAM_MAX_RETRIES', 'RUN_APPROVAL_EXPIRED_CODE', 'RUN_APPROVAL_EXPIRED_TEXT'].map(constSource).join('\n')
  const fns = ['isEntityId', 'idSeg', 'esc', 'runMessagesHtml', 'runToolsHtml', 'runFailureText', 'toolInterruptedText', 'runEventText', 'runToolbarHtml', 'renderRunView', 'renderStreamStatus', 'listenRun', 'connectRunStream', 'syncRunFromRest', 'endRunStream', 'closeStream', 'refreshRunStream'].map(fnSource).join('\n')
  const body = `${consts}\n${fns}\nreturn { ${method('openRun')}, closeStream, refreshRunStream };`
  const app = new Function(...names, body)(...names.map((n) => deps[n])) as { openRun(id: string): Promise<void>; closeStream(): void; refreshRunStream(): Promise<void> }
  return {
    app, els, calls, toasts, state, modal,
    reply: (...r: unknown[]) => { responses.push(...r) },
    defer: () => { deferred = true },
    resolvePending: (v: unknown) => { const p = pending; pending = []; deferred = false; for (const r of p) r(v) },
    es: () => FakeES.instances.at(-1)!,
    stream: () => els['run-stream']?.innerHTML ?? '',
    messages: () => els['run-messages']?.innerHTML ?? '',
  }
}

async function opened(initial = run('running', [msg('m1', 1, 'user', 'hi')])) {
  const h = harness(initial)
  await h.app.openRun(RUN_ID)
  return h
}

describe('FE-R5 message.completed：以 REST 为准重渲染消息区', () => {
  it('收到 completed 后重取 GET /admin/api/runs/:id，新 id 的 assistant 消息追加显示，不用重开弹窗', async () => {
    const h = await opened()
    expect(h.calls).toEqual([`/admin/api/runs/${RUN_ID}`])
    h.reply(run('running', [msg('m1', 1, 'user', 'hi'), msg('m2', 2, 'assistant', '你好，我是 Forge')]))
    h.es().emit('message.completed', 3, { text: '你好，我是 Forge', usage: {} })
    await flush()
    expect(h.calls).toEqual([`/admin/api/runs/${RUN_ID}`, `/admin/api/runs/${RUN_ID}`])
    expect(h.messages()).toContain('data-message-id="m1"')
    expect(h.messages()).toContain('data-message-id="m2"')
    expect(h.messages().indexOf('m1')).toBeLessThan(h.messages().indexOf('m2'))
    expect(h.messages()).toContain('你好，我是 Forge')
  })

  it('同 id 的消息被 REST 全文覆盖，不重复出现', async () => {
    const h = await opened(run('running', [msg('m1', 1, 'user', 'hi'), msg('m2', 2, 'assistant', '旧内容')]))
    h.reply(run('running', [msg('m1', 1, 'user', 'hi'), msg('m2', 2, 'assistant', '完整的新内容')]))
    h.es().emit('message.completed', 3, { text: '完整的新内容' })
    await flush()
    expect(h.messages().match(/data-message-id="m2"/g)).toHaveLength(1)
    expect(h.messages()).toContain('完整的新内容')
    expect(h.messages()).not.toContain('旧内容')
  })

  it.each(['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>'])('消息内容 %s 被转义', async (evil) => {
    const h = await opened()
    h.reply(run('running', [msg('m1', 1, 'user', 'hi'), msg(evil, 2, 'assistant', evil)]))
    h.es().emit('message.completed', 3, { text: evil })
    await flush()
    expect(h.messages()).not.toMatch(/<script|<img|<svg/)
    expect(h.messages()).toContain('&lt;')
    // 事件日志行同样转义
    const row = h.els['event-log'].children.at(-1)!
    expect(row.innerHTML).not.toMatch(/<script|<img|<svg/)
  })

  it('不在前端用事件 text 拼消息：REST 失败时消息区保持原样', async () => {
    const h = await opened()
    h.reply(() => Promise.reject(new Error('boom')))
    h.es().emit('message.completed', 3, { text: '只在事件里的文本' })
    await flush()
    expect(h.messages()).not.toContain('只在事件里的文本')
  })
})

describe('FE-R5 run.* 结束：关流并以 REST 为准', () => {
  it.each(['run.completed', 'run.failed', 'run.cancelled', 'run.budget_exhausted'])('%s 后关流、重取 REST、状态和消息按 REST 渲染、「生成中…」移除', async (type) => {
    const h = await opened()
    expect(h.stream()).toContain('生成中…')
    const status = type === 'run.completed' ? 'succeeded' : type.slice(4)
    h.reply(run(status, [msg('m1', 1, 'user', 'hi'), msg('m2', 2, 'assistant', '最终回复')]))
    h.es().emit(type, 9, { status })
    await flush()
    expect(h.es().closed).toBe(true)
    expect(h.calls).toHaveLength(2)
    expect(h.els['run-toolbar'].innerHTML).toContain(status)
    expect(h.messages()).toContain('最终回复')
    expect(h.stream()).not.toContain('生成中')
  })

  it('打开时 Run 已结束：不显示「生成中…」', async () => {
    const h = await opened(run('succeeded', [msg('m1', 1, 'user', 'hi')]))
    expect(h.stream()).not.toContain('生成中')
  })

  it('打开时 Run 已结束：服务端回放完结束流触发 onerror，直接关流，不进入重连', async () => {
    const h = await opened(run('succeeded', [msg('m1', 1, 'user', 'hi')]))
    h.es().fail(0)
    await flush()
    expect(h.es().closed).toBe(true)
    expect(h.stream()).not.toMatch(/生成中|正在重连|连接已断开/)
  })

  it('打开时 Run 进行中：显示「生成中…」', async () => {
    const h = await opened()
    expect(h.stream()).toContain('生成中…')
  })
})

describe('FE-R5 断线重连：只靠 EventSource 自带重连（Last-Event-ID），有限次', () => {
  it('浏览器重连中（CONNECTING）：不新建连接，显示重连状态而不是「生成中…」', async () => {
    const h = await opened()
    h.es().open()
    h.reply(run('running', [msg('m1', 1, 'user', 'hi')]))
    h.es().fail(0)
    await flush()
    expect(FakeES.instances).toHaveLength(1)
    expect(h.es().closed).toBe(false)
    expect(h.stream()).toContain('正在重连')
    expect(h.stream()).not.toContain('生成中')
  })

  it('重连成功（open）后回到「生成中…」，并用 REST 整体重渲染', async () => {
    const h = await opened()
    h.es().open()
    h.reply(run('running', [msg('m1', 1, 'user', 'hi')]))
    h.es().fail(0)
    await flush()
    const before = h.calls.length
    h.reply(run('running', [msg('m1', 1, 'user', 'hi'), msg('m2', 2, 'assistant', '断线期间的回复')]))
    h.es().open()
    await flush()
    expect(h.calls.length).toBe(before + 1)
    expect(h.messages()).toContain('断线期间的回复')
    expect(h.stream()).toContain('生成中…')
  })

  it('连续 3 次重连失败后关流，显示「连接已断开，点此刷新」，不再转圈', async () => {
    const h = await opened()
    for (let i = 0; i < 3; i++) { h.reply(run('running', [])); h.es().fail(0); await flush() }
    expect(h.es().closed).toBe(false)
    h.reply(run('running', []))
    h.es().fail(0)
    await flush()
    expect(h.es().closed).toBe(true)
    expect(FakeES.instances).toHaveLength(1)
    expect(h.stream()).toContain('连接已断开，点此刷新')
    expect(h.stream()).not.toContain('生成中')
    expect(h.stream()).not.toContain('正在重连')
  })

  it('浏览器放弃重连（CLOSED）：直接显示「连接已断开，点此刷新」', async () => {
    const h = await opened()
    h.reply(run('running', []))
    h.es().fail(2)
    await flush()
    expect(h.stream()).toContain('连接已断开，点此刷新')
    expect(h.stream()).not.toContain('生成中')
  })

  it('点「点此刷新」重取 REST；Run 仍在进行就清空事件日志重新订阅', async () => {
    const h = await opened()
    h.reply(run('running', []))
    h.es().fail(2)
    await flush()
    h.els['event-log'].appendChild(new El())
    const before = h.calls.length
    h.reply(run('running', [msg('m1', 1, 'user', 'hi'), msg('m2', 2, 'assistant', '刷新后看到')]))
    const target = { closest: (s: string) => (s.includes('data-run-refresh') ? {} : null) }
    h.els['run-stream'].onclick!({ target })
    await flush()
    expect(h.calls.length).toBe(before + 1)
    expect(h.messages()).toContain('刷新后看到')
    expect(FakeES.instances).toHaveLength(2)
    expect(h.els['event-log'].children).toHaveLength(0)
    expect(h.stream()).toContain('生成中…')
  })

  it('断线时 REST 显示 Run 已结束：不显示断开提示，按 REST 渲染终态', async () => {
    const h = await opened()
    h.reply(run('succeeded', [msg('m2', 2, 'assistant', '已完成')]))
    h.es().fail(0)
    await flush()
    expect(h.es().closed).toBe(true)
    expect(h.stream()).not.toMatch(/生成中|正在重连|连接已断开/)
    expect(h.messages()).toContain('已完成')
  })
})

describe('FE-R5 关闭弹窗', () => {
  it('旧表单的 close 事件迟到时，不关闭已复用为 Run 详情的新事件流', async () => {
    const h = await opened()
    const es = h.es()
    h.modal.dispatch('close')
    expect(h.modal.open).toBe(true)
    expect(es.closed).toBe(false)
    h.reply(run('cancelled', [msg('m2', 2, 'assistant', '已取消')]))
    es.emit('run.cancelled', 4, { status: 'cancelled' })
    await flush()
    expect(h.els['run-toolbar'].innerHTML).toContain('cancelled')
    expect(h.messages()).toContain('已取消')
    expect(h.state.runView).not.toBeNull()
  })

  it('关弹窗后关流；旧连接再报错或来事件都不重连、不渲染', async () => {
    const h = await opened()
    const es = h.es()
    h.modal.close()
    expect(es.closed).toBe(true)
    expect(h.state.runView).toBeNull()
    expect(h.state.eventSource).toBeNull()
    const before = h.calls.length
    es.fail(0); es.fail(2); es.emit('message.completed', 3, { text: 'x' })
    await flush()
    expect(h.calls.length).toBe(before)
    expect(FakeES.instances).toHaveLength(1)
  })

  it('关弹窗前发出的 REST 请求迟到返回，不再渲染', async () => {
    const h = await opened()
    h.defer()
    h.es().emit('message.completed', 3, { text: 'x' })
    h.modal.close()
    const html = h.messages()
    h.resolvePending(run('succeeded', [msg('m9', 9, 'assistant', '迟到的')]))
    await flush()
    expect(h.messages()).toBe(html)
  })
})

describe('FE-R5 严格 CSP：新增渲染不引入内联 style / 内联事件', () => {
  it('流状态和重连代码里没有 style= 和 on*= 属性', () => {
    const src = ['renderStreamStatus', 'listenRun', 'connectRunStream', 'syncRunFromRest', 'endRunStream', 'refreshRunStream'].map(fnSource).join('\n')
    expect(src).not.toMatch(/style=/)
    expect(src).not.toMatch(/\son[a-z]+="/)
  })
})
