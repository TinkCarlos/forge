import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * K-33：新控制台「在旧版中查看详情」跳 `/#agents/<id>`，旧版要打开 Agents 页并弹出该 Agent 的详情。
 * hash 里的 id 经过 encodeURIComponent，并按仓库 id 格式（26 位纯 ULID，或 3 位小写前缀 + "_" + 22 位 ULID 字符）校验，
 * 不合法时停在 Agents 列表、不发详情请求；其他页不认 id；hashchange 对旧版自己写入的 hash 不重复渲染。
 */
const A1 = 'agt_01M5PK6G1GPZ3APBN3QNXR'
const A2 = '01J00000000000000000000006'
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')

function fnSource(name: string): string | undefined {
  return APP.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))?.[0]
}

const TABS = { dashboard: ['总览', ''], agents: ['Agents', ''], runs: ['运行中心', ''] }

function harness(hash = '') {
  const events: string[] = []
  const state: Record<string, unknown> = { tab: 'dashboard' }
  const location = { hash }
  const el = () => ({ textContent: '', innerHTML: '' })
  const els: Record<string, ReturnType<typeof el>> = {}
  const deps = {
    state,
    tabMeta: TABS,
    location,
    $: (sel: string) => (els[sel] ??= el()),
    renderNav: () => {},
    renderCurrent: async () => { events.push(`render:${state.tab}`) },
    canPermission: () => true,
    errorCard: () => 'error',
    app: { openAgentDetail: async (id: string) => { events.push(`detail:${id}`) }, openRun: async (id: string) => { events.push(`run:${id}`) }, openAgentCreate: () => { events.push('create') } },
  }
  const fns = ['isEntityId', 'parseRoute', 'switchTab', 'onHashChange'].map(fnSource).filter(Boolean).join('\n')
  const names = Object.keys(deps)
  const api = new Function(...names, `${fns}\nreturn { switchTab, onHashChange: typeof onHashChange === 'function' ? onHashChange : undefined }`)(
    ...names.map((n) => deps[n as keyof typeof deps])
  ) as { switchTab(route: string): Promise<void>; onHashChange?: () => Promise<void> | void }
  return { ...api, events, state, location }
}

describe('K-33 旧版 #agents/<id> 深链', () => {
  it('clicking the same name after closing details explicitly navigates again', () => {
    const calls: string[] = []
    let click: (event: { target: unknown; preventDefault(): void }) => void = () => {}
    class Anchor {
      dataset = { action: 'agent-detail', agentId: A1 }
      closest() { return this }
    }
    const anchor = new Anchor()
    const content = { contains: (node: unknown) => node === anchor, addEventListener: (_type: string, listener: typeof click) => { click = listener } }
    new Function('Element', '$', 'app', `let agentActionsBound = false; ${fnSource('bindAgentActions')}\nbindAgentActions();`)(Anchor, () => content, { switchTab: (route: string) => calls.push(route) })
    let prevented = 0
    click({ target: anchor, preventDefault: () => { prevented++ } })
    click({ target: anchor, preventDefault: () => { prevented++ } })
    expect(calls).toEqual([`agents/${A1}`, `agents/${A1}`])
    expect(prevented).toBe(2)
  })
  it('switchTab("agents/<id>") 渲染 Agents 页后打开该 Agent 详情，hash 保留 id', async () => {
    const h = harness()
    await h.switchTab(`agents/${A1}`)
    expect(h.state.tab).toBe('agents')
    expect(h.events).toEqual(['render:agents', `detail:${A1}`])
    expect(h.location.hash).toBe(`agents/${A1}`)
  })

  it('纯 ULID（seed）同样可以打开详情', async () => {
    const h = harness()
    await h.switchTab(`agents/${A2}`)
    expect(h.events).toEqual(['render:agents', `detail:${A2}`])
  })

  it('审批深链接直接读取指定 Run，不依赖它是否出现在最近运行列表', async () => {
    const h = harness()
    await h.switchTab(`runs/${A2}`)
    expect(h.events).toEqual(['render:runs', `run:${A2}`])
    expect(h.location.hash).toBe(`runs/${A2}`)
  })

  it('新建入口直接打开草稿表单', async () => {
    const h = harness()
    await h.switchTab('agents/new')
    expect(h.events).toEqual(['render:agents', 'create'])
  })

  it.each([
    ['含 / 的 id', `agents/${encodeURIComponent('ag 中/1')}`],
    ['../', 'agents/../users'],
    ['..%2F..%2F', 'agents/..%2F..%2Fusers'],
    ['?', 'agents/x?y=1'],
    ['#', 'agents/x#y'],
    ['HTML', `agents/${encodeURIComponent('<img src=x onerror=alert(1)>')}`],
    ['超长', `agents/${'A'.repeat(5000)}`],
    ['不是本仓库格式', 'agents/ag_1'],
  ])('非法 id（%s）：停在 Agents 列表，不发详情请求，hash 只剩 agents', async (_l, route) => {
    const h = harness()
    await h.switchTab(route)
    expect(h.state.tab).toBe('agents')
    expect(h.events).toEqual(['render:agents'])
    expect(h.location.hash).toBe('agents')
  })

  it('不带 id 时只渲染列表；其他页带 id 时忽略 id；未知页回总览', async () => {
    const a = harness(); await a.switchTab('agents')
    expect(a.events).toEqual(['render:agents']); expect(a.location.hash).toBe('agents')
    const b = harness(); await b.switchTab('runs/xyz')
    expect(b.events).toEqual(['render:runs']); expect(b.location.hash).toBe('runs')
    const c = harness(); await c.switchTab(`nope/${A1}`)
    expect(c.events).toEqual(['render:dashboard']); expect(c.location.hash).toBe('dashboard')
  })

  it('非法的百分号编码不抛错，只打开列表', async () => {
    const h = harness()
    await h.switchTab('agents/%E0%A4%A')
    expect(h.events).toEqual(['render:agents'])
  })

  it('hashchange 处理 #agents/<id>；对旧版自己刚写入的 hash 不再渲染一次', async () => {
    const h = harness(`#agents/${A2}`)
    expect(h.onHashChange).toBeTypeOf('function')
    await h.onHashChange!()
    expect(h.events).toEqual(['render:agents', `detail:${A2}`])
    h.location.hash = `#agents/${A2}`
    await h.onHashChange!()
    expect(h.events).toEqual(['render:agents', `detail:${A2}`])
    h.location.hash = '#agents'
    await h.onHashChange!()
    expect(h.events).toEqual(['render:agents', `detail:${A2}`, 'render:agents'])
  })

  it('hashchange 监听和进入应用都走带 id 的路由', () => {
    expect(APP).toMatch(/addEventListener\("hashchange", onHashChange\)/)
    expect(fnSource('enterApp')).toMatch(/switchTab\(location\.hash\.slice\(1\) \|\| "dashboard"\)/)
  })
})
