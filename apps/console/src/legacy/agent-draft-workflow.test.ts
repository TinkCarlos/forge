import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const method = (name: string) => {
  const match = source.match(new RegExp(`^  (?:async )?${name}\\([^)]*\\) \\{[\\s\\S]*?^  \\},?$`, 'm'))
  if (!match) throw new Error(`missing ${name}`)
  return match[0].replace(/,$/, '')
}
const readable = source.match(/^function agentReadableConfig\([\s\S]*?^\}/m)?.[0] ?? ''
type Form = { get(name: string): string | null }
type Modal = { title: string; body: string; submit(data: Form): Promise<unknown>; label: string }

function harness(spec: Record<string, unknown> = { model: { provider: 'mock', model: 'mock-1' } }) {
  const modals: Modal[] = []
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  const detail = { name: 'Live Agent', revision: 2, versions: [{ id: 'version-1', version: '1.0.0', status: 'published', instructions: 'Original', spec_json: spec }] }
  const deps = {
    state: { navigation: 1 },
    canPermission: () => true,
    field: () => '', textarea: () => '',
    agentSpecFields: () => '', bindAgentSpecEditor: () => {},
    openModal: (title: string, body: string, submit: Modal['submit'], label: string) => modals.push({ title, body, submit, label }),
    parseJsonField: (data: Form, key: string) => JSON.parse(data.get(key) ?? '{}') as unknown,
    api: async (path: string, opts?: { body: Record<string, unknown> }) => {
      if (opts) writes.push({ path, body: opts.body })
      return detail
    },
    toast: () => {}, errorText: (error: Error) => error.message,
    $: () => null, esc: (value: unknown) => String(value ?? ''), json: (value: unknown) => JSON.stringify(value), vLabel: (value: string) => `v${value}`,
    renderAgents: async () => {}, idSeg: (id: string) => id,
    agentNameById: () => 'Live Agent', revisionHeaders: () => ({ 'If-Match': '"2"' }),
  }
  const actions = new Function(...Object.keys(deps), `${readable}\nreturn {${method('openAgentCreate')},${method('openAgentNewVersion')},${method('openAgentDetail')}}`)(...Object.values(deps)) as {
    openAgentCreate(): void
    openAgentNewVersion(id: string): Promise<void>
    openAgentDetail(id: string): Promise<void>
  }
  const values: Record<string, string> = { key: 'draft-agent', name: 'Draft Agent', description: '', instructions: 'Draft', version: '1.1.0', spec: '{"model":{"provider":"mock","model":"mock-1"}}' }
  const data: Form = { get: (key) => values[key] ?? null }
  return { actions, modals, writes, data }
}

describe('Agent configuration is saved before publishing', () => {
  it('an administrator creates a draft without publishing', async () => {
    const h = harness()
    h.actions.openAgentCreate()
    await h.modals[0]!.submit(h.data)
    expect(h.modals[0]!.label).toBe('保存草稿')
    expect(h.writes[0]!.body.publish).toBe(false)
  })

  it('a new version preserves the live version until a separate publish', async () => {
    const h = harness()
    await h.actions.openAgentNewVersion('agent-1')
    await h.modals[0]!.submit(h.data)
    expect(h.modals[0]!.label).toBe('保存草稿')
    expect(h.writes[0]!.body.publish).toBe(false)
  })
  it('an unsupported legacy Spec still opens readable details and the original JSON', async () => {
    const h = harness({ skills: {}, toolsets: [null, { builtin: 'old-format' }] })
    await h.actions.openAgentDetail('agent-1')
    expect(h.modals).toHaveLength(1)
    expect(h.modals[0]!.body).toContain('请查看高级配置')
    expect(h.modals[0]!.body).toContain('old-format')
  })
  it.each([
    { skills: [{ toString: null }] },
    { toolsets: [{ builtin: [{ toString: null }] }] },
    { toolsets: [{ mcp: { toString: null } }] },
    { model: { provider: { toString: null }, model: 'm1' } },
    { limits: { maxCostUsd: { toString: null } } },
  ])('object-valued advanced fields do not prevent opening details: %j', async (spec) => {
    const h = harness(spec)
    await h.actions.openAgentDetail('agent-1')
    expect(h.modals).toHaveLength(1)
    expect(h.modals[0]!.body).toContain('请查看高级配置')
  })
})
