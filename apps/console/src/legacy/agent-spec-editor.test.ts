import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const fn = (name: string) => {
  const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!match) throw new Error(`missing ${name}`)
  return match[0]
}
type Spec = { model: { provider: string; model: string; temperature?: number; maxTokens?: number }; limits: { maxSteps: number; maxCostUsd: number }; skills: string[]; toolsets: Array<{ builtin?: string[]; mcp?: string; openapi?: string; allow?: string[] }>; output: { schema: { type: string } } }
const { editAgentSpec, chooseAgentCapability } = new Function(`${fn('editAgentSpec')}\n${fn('chooseAgentCapability')}\nreturn {editAgentSpec,chooseAgentCapability}`)() as {
  editAgentSpec(spec: Spec, field: string, value: string): Spec
  chooseAgentCapability(spec: Spec, kind: string, key: string, checked: boolean, previous?: Spec['toolsets']): Spec
}
const original: Spec = { model: { provider: 'private', model: 'm1', maxTokens: 4096 }, limits: { maxSteps: 7, maxCostUsd: 2 }, skills: ['hidden-skill'], toolsets: [{ mcp: 'erp', allow: ['read'] }, { builtin: ['echo', 'other-tool'] }], output: { schema: { type: 'object' } } }

describe('basic Agent configuration preserves advanced settings', () => {
  it('changes a basic field without dropping output, tool or provider settings', () => {
    const result = editAgentSpec(original, 'model.model', 'm2')
    expect(result.model).toEqual({ provider: 'private', model: 'm2', maxTokens: 4096 })
    expect(result.output).toEqual(original.output)
    expect(result.toolsets).toEqual(original.toolsets)
    expect(original.model.model).toBe('m1')
  })
  it('converts numbers, clears an optional override, and rejects unknown fields', () => {
    expect(editAgentSpec(original, 'model.temperature', '0.3').model.temperature).toBe(0.3)
    expect(editAgentSpec(original, 'model.temperature', '').model).not.toHaveProperty('temperature')
    expect(() => editAgentSpec(original, '__proto__.admin', 'true')).toThrow('未知配置字段')
  })
  it('toggling one builtin retains unlisted tools and restricted MCP permissions', () => {
    const result = chooseAgentCapability(original, 'builtin', 'echo', false)
    expect(result.toolsets).toEqual([{ mcp: 'erp', allow: ['read'] }, { builtin: ['other-tool'] }])
    expect(chooseAgentCapability(original, 'mcp', 'erp', true).toolsets).toContainEqual({ mcp: 'erp', allow: ['read'] })
  })
  it('a new skill does not erase skills outside the visible directory', () => {
    expect(chooseAgentCapability(original, 'skills', 'visible-skill', true).skills).toEqual(['hidden-skill', 'visible-skill'])
    expect(chooseAgentCapability(original, 'skills', 'visible-skill', false).skills).toEqual(['hidden-skill'])
  })
  it.each(['mcp', 'openapi'])('uncheck then restore %s never broadens the original allow list', (kind) => {
    const group = { [kind]: 'erp', allow: ['read'] }
    const spec = { ...original, toolsets: [group] }
    const removed = chooseAgentCapability(spec, kind, 'erp', false)
    expect(removed.toolsets).toEqual([])
    const restored = chooseAgentCapability(removed, kind, 'erp', true, [group])
    expect(restored.toolsets).toEqual([group])
    expect(restored.toolsets[0]!.allow).toEqual(['read'])
  })
})
