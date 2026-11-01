import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const fn = (name: string) => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!match) throw new Error(`missing ${name}`)
  return match[0]
}
const id = '01J00000000000000000000006'
const row = (status: string) => ({ id, status, agentName: 'Agent', triggerType: 'manual', costUsd: 0, createdAt: '2026-11-01' })
type Run = ReturnType<typeof row>

function harness(status = 'succeeded', tab = 'runs') {
  const view = { runId: id, sync: 0, finished: false }
  const state = { navigation: 1, tab, runView: view, runs: [row('queued')] }
  const content = { innerHTML: 'queued; cancel' }
  const calls: string[] = []
  let list: () => Promise<{ items: Run[] }> = async () => ({ items: [row(status)] })
  const deps = {
    state, RUN_ACTIVE_STATUSES: ['queued', 'running', 'waiting_approval'], idSeg: String,
    api: async (path: string) => { calls.push(path); return path.includes('?') ? list() : row(status) },
    renderRunView: () => {}, endRunStream: () => {}, renderStreamStatus: () => {},
    toast: () => {}, errorText: String, $: () => content, esc: String, statusPill: String, fmt: String,
    canPermission: () => true, empty: () => '',
  }
  const actions = new Function(...Object.keys(deps), `${fn('renderRuns')}\n${fn('syncRunFromRest')}\nreturn {renderRuns,syncRunFromRest}`)(...Object.values(deps)) as {
    renderRuns(): Promise<void>
    syncRunFromRest(value: typeof view): Promise<void>
  }
  return { actions, view, state, content, calls, setList: (value: typeof list) => { list = value } }
}

describe('Run terminal state and list stay consistent', () => {
  it.each(['succeeded', 'failed', 'cancelled', 'budget_exhausted'])('%s updates the list and removes the cancel action', async (status) => {
    const h = harness(status)
    await h.actions.syncRunFromRest(h.view)
    expect(h.state.runs[0]!.status).toBe(status)
    expect(h.content.innerHTML).not.toContain('>取消</')
  })
  it('does not replace another page with the Run list', async () => {
    const h = harness('succeeded', 'approvals')
    await h.actions.syncRunFromRest(h.view)
    expect(h.calls).toHaveLength(1)
  })
  it('ignores a list response arriving after navigation', async () => {
    const h = harness()
    let resolve: (value: { items: Run[] }) => void = () => {}
    h.setList(() => new Promise((done) => { resolve = done }))
    const pending = h.actions.renderRuns()
    h.state.navigation++; h.state.tab = 'agents'; h.content.innerHTML = 'Agent page'
    resolve({ items: [row('succeeded')] })
    await pending
    expect(h.content.innerHTML).toBe('Agent page')
  })
  it('an older running response cannot overwrite a newer terminal response', async () => {
    const h = harness()
    let resolve: (value: { items: Run[] }) => void = () => {}
    h.setList(() => new Promise((done) => { resolve = done }))
    const old = h.actions.renderRuns()
    h.setList(async () => ({ items: [row('succeeded')] }))
    await h.actions.renderRuns()
    resolve({ items: [row('running')] })
    await old
    expect(h.state.runs[0]!.status).toBe('succeeded')
  })
})
