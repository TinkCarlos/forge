import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * P2：旧版所有用 id 拼出的 API 路径，id 先按仓库 id 格式校验（26 位纯 ULID，或 3 位小写前缀 + "_" + 22 位 ULID 字符），
 * 不合法直接报中文错误、不发请求；合法的照旧 encodeURIComponent。
 * 新建定时任务：Agent / 服务账号下拉没有可选值时前端拦住并给中文提示，不发请求。
 */
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')

function fnSource(name: string): string | undefined {
  return APP.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))?.[0]
}
function method(name: string): string {
  const m = APP.match(new RegExp(`^  (?:async )?${name}\\([^)]*\\) \\{[\\s\\S]*?^  \\},?$`, 'm'))
  if (!m) throw new Error(`method ${name} not found in app.js`)
  return m[0].replace(/,$/, '')
}

const VALID_IDS = ['01J00000000000000000000006', 'agt_01M5PK6G1GPZ3APBN3QNXR', 'apr_01M5PK6G1GPZ3APBN3QNXR']
const MALICIOUS_IDS = [
  '../users', '..%2Fusers', '..%2F..%2F', '..', '.', '', 'a b/c?d#e', '?x=1', '#frag',
  '<img src=x onerror=alert(1)>', 'A'.repeat(5000), '01J0000000000000000000000O', 'agt_01M5PK6G1GPZ3APBN3QNX', 'AGT_01M5PK6G1GPZ3APBN3QNXR',
]

function harness(extra: Record<string, unknown> = {}) {
  const calls: { path: string; method: string; body?: unknown }[] = []
  const toasts: [string, string?][] = []
  let submit: ((data: FormData) => Promise<void>) | undefined
  let opened = 0
  const deps: Record<string, unknown> = {
    state: { agents: [], serviceAccounts: [] },
    api: async (path: string, opts: { method?: string; body?: unknown } = {}) => { calls.push({ path, method: opts.method ?? 'GET', body: opts.body }); return { versions: [], name: 'x' } },
    openModal: (_t: string, _h: string, cb: (d: FormData) => Promise<void>) => { opened++; submit = cb },
    toast: (m: string, t?: string) => { toasts.push([m, t]) },
    errorText: (e: Error) => e.message, json: (v: unknown) => JSON.stringify(v), field: () => '', textarea: () => '', select: () => '',
    renderSchedules: async () => {}, renderAgents: async () => {}, esc: String, agentNameById: (id: string) => id,
    ...extra,
  }
  const names = Object.keys(deps)
  const helpers = ['isEntityId', 'idSeg'].map(fnSource).filter(Boolean).join('\n')
  const body = `${helpers}\nreturn { ${method('openAgentDetail')}, ${method('openScheduleCreate')} };`
  const app = new Function(...names, body)(...names.map((n) => deps[n])) as { openAgentDetail(id: string): Promise<void>; openScheduleCreate(): void }
  return { app, calls, toasts, submit: () => submit, opened: () => opened, deps }
}

describe('P2 旧版 API 路径里的 id 先校验再编码', () => {
  it.each(VALID_IDS)('合法 id %s 原样落在 /admin/api/agents/<id>', async (id) => {
    const h = harness()
    await h.app.openAgentDetail(id)
    expect(h.calls.map((c) => c.path)).toEqual([`/admin/api/agents/${id}`])
  })

  it.each(MALICIOUS_IDS.map((id) => [id.length > 60 ? `${id.slice(0, 20)}…(${id.length})` : id, id]))('非法 id %j 不发请求，提示「ID 格式无效」', async (_label, id) => {
    const h = harness()
    await h.app.openAgentDetail(id)
    expect(h.calls).toEqual([])
    expect(h.toasts.at(-1)?.[0]).toMatch(/ID 格式无效/)
  })

  it('app.js 里所有带 ${…} 的 /admin/api/ 路径和 EventSource 地址，插值都包在 idSeg() 里', () => {
    const templates = APP.match(/`\/admin\/api\/[^`]*`/g) ?? []
    const withExpr = templates.filter((t) => t.includes('${'))
    expect(withExpr.length).toBeGreaterThan(25)
    const bad = withExpr.filter((t) => [...t.matchAll(/\$\{([^}]*)\}/g)].some((m) => !/^idSeg\(/.test(m[1])))
    expect(bad).toEqual([])
    expect(APP).toMatch(/new EventSource\(`\/admin\/api\/runs\/\$\{idSeg\(runId\)\}\/events`\)/)
  })
})

describe('P2 旧版新建定时任务：下拉没有可选值时不发请求', () => {
  const okAgents = [{ id: VALID_IDS[1], name: 'A', status: 'published' }]
  const okAccounts = [{ id: 'svc_01M5PK6G1GPZ3APBN3QNXR', name: 'svc', status: 'active' }]

  it('没有 Agent / 没有可用服务账号时不打开弹窗，给中文提示', () => {
    const a = harness({ state: { agents: [], serviceAccounts: okAccounts } })
    a.app.openScheduleCreate()
    expect(a.opened()).toBe(0); expect(a.calls).toEqual([]); expect(a.toasts[0][0]).toMatch(/Agent/)
    const b = harness({ state: { agents: okAgents, serviceAccounts: [{ ...okAccounts[0], status: 'disabled' }] } })
    b.app.openScheduleCreate()
    expect(b.opened()).toBe(0); expect(b.calls).toEqual([]); expect(b.toasts[0][0]).toMatch(/服务账号/)
  })

  const form = (fields: Record<string, string>) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries({ name: 'n', cron: '0 9 * * *', timezone: 'Asia/Shanghai', input: '{}', ...fields })) fd.set(k, v)
    return fd
  }

  it.each([
    ['agentId 缺失', {}, /请选择 Agent/],
    ['agentId 为空', { agentId: '', serviceAccountId: okAccounts[0].id }, /请选择 Agent/],
    ['serviceAccountId 缺失', { agentId: okAgents[0].id }, /请选择运行身份/],
    ['serviceAccountId 为空', { agentId: okAgents[0].id, serviceAccountId: '' }, /请选择运行身份/],
  ])('提交时 %s：抛中文提示，不发请求', async (_l, fields, msg) => {
    const h = harness({ state: { agents: okAgents, serviceAccounts: okAccounts } })
    h.app.openScheduleCreate()
    expect(h.opened()).toBe(1)
    await expect(h.submit()!(form(fields as Record<string, string>))).rejects.toThrow(msg)
    expect(h.calls).toEqual([])
  })

  it('两个都选了才 POST /admin/api/schedules', async () => {
    const h = harness({ state: { agents: okAgents, serviceAccounts: okAccounts } })
    h.app.openScheduleCreate()
    await h.submit()!(form({ agentId: okAgents[0].id, serviceAccountId: okAccounts[0].id }))
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /admin/api/schedules'])
  })
})
