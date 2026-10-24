import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 后端 48d829d 起 PATCH /admin/api/schedules/:id 带 status 字段返回 400（ajv additionalProperties:false）。
 * 编辑表单只能发 name / cron / timezone / input；启用 / 停用必须走 POST /:id/enable | /:id/disable。
 */
const src = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')

/** 从 app 对象字面量里取出一个方法（两格缩进的 `name(...) {` 到下一行的 `  },`）。 */
function method(name: string): string {
  const re = new RegExp(`^  (?:async )?${name}\\([^)]*\\) \\{[\\s\\S]*?^  \\},?$`, 'm')
  const m = src.match(re)
  if (!m) throw new Error(`method ${name} not found in app.js`)
  return m[0].replace(/,$/, '')
}
function topFn(name: string): string {
  const m = src.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}$`, 'm'))
  if (!m) throw new Error(`function ${name} not found in app.js`)
  return m[0]
}

type Call = { path: string; method: string; body: Record<string, unknown> }
const schedule = { id: 'sch_01M5PK6G1GPZ3APBN3QNXR', name: '日报', cron: '0 9 * * *', timezone: 'Asia/Shanghai', input_json: { text: 'hi' }, status: 'active', next_run_at: null }

function harness() {
  const calls: Call[] = []
  let submit: ((data: FormData) => Promise<void>) | undefined
  const deps = {
    state: { schedules: [schedule] },
    api: async (path: string, opts: { method?: string; body?: Record<string, unknown> } = {}) => {
      calls.push({ path, method: opts.method ?? 'GET', body: opts.body ?? {} })
      return {}
    },
    openModal: (_t: string, _html: string, cb: (data: FormData) => Promise<void>) => { submit = cb },
    field: () => '', textarea: () => '', toast: () => {}, renderSchedules: async () => {},
    switchTab: async () => {}, fmt: (v: unknown) => String(v), confirmAction: async () => true,
  }
  const names = Object.keys(deps)
  const body = `${topFn('parseJsonField')}\n${topFn('isEntityId')}\n${topFn('idSeg')}\nreturn { ${method('openScheduleEdit')}, ${method('scheduleAction')} };`
  const app = new Function(...names, body)(...names.map((n) => deps[n as keyof typeof deps])) as {
    openScheduleEdit(id: string): void
    scheduleAction(id: string, action: string): Promise<void>
  }
  return { app, calls, submit: () => submit! }
}

function form(values: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(values)) f.set(k, v)
  return f
}

describe('旧控制台 schedule 编辑不带 status', () => {
  it('编辑提交的 PATCH body 只含 name/cron/timezone/input，不含 status', async () => {
    const h = harness()
    h.app.openScheduleEdit('sch_01M5PK6G1GPZ3APBN3QNXR')
    await h.submit()(form({ name: '日报2', cron: '0 10 * * *', timezone: 'Asia/Shanghai', input: '{"text":"x"}' }))
    const patch = h.calls.filter((c) => c.method === 'PATCH')
    expect(patch).toHaveLength(1)
    expect(patch[0].path).toBe('/admin/api/schedules/sch_01M5PK6G1GPZ3APBN3QNXR')
    expect(patch[0].body).not.toHaveProperty('status')
    expect(Object.keys(patch[0].body).sort()).toEqual(['cron', 'input', 'name', 'timezone'])
  })

  it.each(['enable', 'disable'])('%s 走 POST /admin/api/schedules/:id/{enable,disable}，不发 PATCH', async (action) => {
    const h = harness()
    await h.app.scheduleAction('sch_01M5PK6G1GPZ3APBN3QNXR', action)
    expect(h.calls).toEqual([{ path: `/admin/api/schedules/sch_01M5PK6G1GPZ3APBN3QNXR/${action}`, method: 'POST', body: {} }])
  })
})

describe('新控制台 /next/ 源码不发带 status 的 schedule PATCH', () => {
  it('apps/console/src 里没有对 /schedules 的 PATCH 携带 status', () => {
    const root = new URL('../', import.meta.url).pathname
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = `${dir}/${name}`
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) {
          const code = readFileSync(p, 'utf8')
          if (/schedules/.test(code) && /PATCH/i.test(code) && /\bstatus\b/.test(code)) hits.push(p.slice(root.length))
        }
      }
    }
    walk(root.replace(/\/$/, ''))
    expect(hits).toEqual([])
  })
})
