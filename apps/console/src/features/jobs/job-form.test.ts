import { describe, expect, it } from 'vitest'
import { selectJobTarget, costWithSixDecimals } from './job-form'
import type { JobTarget } from '../../../../../packages/contracts/src/job-api'
import { renameConfigField } from '@/components/config-value'
const target: JobTarget = { kind: 'agent', key: 'first', name: '目标', version: 'v1', checksum: 'a'.repeat(64), inputSchema: { type: 'object' }, outputSchema: {}, runtimeEngine: 'mysql-agent-bridge', snapshotQuality: 'legacy' }
describe('Job form preserves configuration', () => {
  it('selects a target without discarding limits, steps or the outcome', () => {
    const current = selectJobTarget(target)
    current.limits.maxCostUsd = '3.000000'
    current.outcomeNodeKey = 'result'
    const next = selectJobTarget({ ...target, version: 'v2' }, current)
    expect(next.target.version).toBe('v2')
    expect(next.limits).toEqual(current.limits)
    expect(next.nodes).toEqual(current.nodes)
    expect(next.outcomeNodeKey).toBe('result')
    expect(current.target.version).toBe('v1')
  })
  it('formats monetary input without floating point rounding', () => {
    expect(costWithSixDecimals('0.000001')).toBe('0.000001')
    expect(costWithSixDecimals('1.2')).toBe('1.200000')
    expect(costWithSixDecimals('10000')).toBe('10000.000000')
    for (const input of ['', '-1', '1e3', '0.0000001']) expect(() => costWithSixDecimals(input)).toThrow()
  })
  it('renames a field without losing adjacent values and rejects unsafe or duplicate names', () => {
    expect(renameConfigField({ first: 1, second: [true] }, 'first', 'next')).toEqual({ next: 1, second: [true] })
    for (const next of ['', 'second', '__proto__', 'constructor']) expect(() => renameConfigField({ first: 1, second: 2 }, 'first', next)).toThrow()
  })
})
