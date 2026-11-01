import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { headerRowsToRecord } from '@/features/messages/configuration-values'
const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const fn = (name: string) => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!match) throw new Error(`Missing ${name}`)
  return match[0]
}
type Config = null | string | number | boolean | Config[] | { [key: string]: Config }
type Node = { children: Node[]; dataset: Record<string, string>; value?: string; hasAttribute(name: string): boolean; querySelector(selector: string): Node | null }
function container(value: Config[] | { [key: string]: Config }): Node {
  const array = Array.isArray(value)
  return { dataset: { recordArray: String(array) }, hasAttribute: () => false, querySelector: () => null, children: Object.entries(value).map(([key, item]) => {
    const type = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item
    const input: Node = { children: [], dataset: {}, value: String(item ?? ''), hasAttribute: () => false, querySelector: () => null }
    const nested = typeof item === 'object' && item !== null ? container(item) : null
    const content = { ...input, querySelector: (selector: string) => selector === '[data-record-children]' ? nested : input }
    return { ...input, hasAttribute: (name: string) => name === 'data-record-row', querySelector: (selector: string) => selector === '[data-record-key]' ? { ...input, value: key } : selector === '[data-record-type]' ? { ...input, value: type } : content }
  }) }
}
const { readRecordRows, scheduleCronParts, scheduleCronValue, configurationFileText, validateAppScope } = new Function(`${['readRecordRows', 'scheduleCronParts', 'scheduleCronValue', 'configurationFileText', 'validateAppScope'].map(fn).join('\n')};return {readRecordRows,scheduleCronParts,scheduleCronValue,configurationFileText,validateAppScope}`)() as {
  readRecordRows(node: Node, header?: boolean): Config
  scheduleCronParts(cron: string): { period: string; time: string; day: string; weekday: string }
  scheduleCronValue(period: string, time: string, day: string, weekday: string, custom: string): string
  validateAppScope(value: string, existing: string[]): string
  configurationFileText(file: { size: number; text(): Promise<string> }): Promise<string>
}
describe('ordinary-user configuration preserves types and scheduling', () => {
  it('round trips nested input, lists, false, zero, empty strings and null', () => {
    const input = { text: '报告', count: 0, enabled: false, empty: '', value: null, options: { language: 'zh' }, items: [{ name: 'one' }, 3, true] }
    expect(readRecordRows(container(input))).toEqual(input)
    expect(() => readRecordRows(container(JSON.parse('{"__proto__":"bad"}') as Config[]))).toThrow('保留名称')
  })
  it('rejects case-insensitive duplicate headers instead of silently overriding', () => {
    expect(() => readRecordRows(container({ Authorization: 'one', authorization: 'two' }), true)).toThrow('重复')
    expect(() => headerRowsToRecord([{ id: '1', name: 'X-Token', secretId: 'one' }, { id: '2', name: 'x-token', secretId: 'two' }])).toThrow('重复')
    expect(headerRowsToRecord([])).toEqual({})
    expect(() => headerRowsToRecord([{ id: '1', name: 'X-Token', secretId: '' }])).toThrow('选择凭据')
  })
  it.each(['0 9 * * *', '15 8 * * 1', '30 18 15 * *', '20 * * * *'])('round trips common cron %s', cron => {
    const part = scheduleCronParts(cron)
    expect(scheduleCronValue(part.period, part.time, part.day, part.weekday, cron)).toBe(cron)
  })
  it('preserves custom cron, including combined day restrictions, without rewriting it', () => {
    for (const cron of ['*/15 * * * *', '0 9 1 * 1', '0 30 * * *']) {
      expect(scheduleCronParts(cron).period).toBe('custom')
      expect(scheduleCronValue('custom', '09:00', '1', '1', cron)).toBe(cron)
    }
    expect(() => scheduleCronValue('monthly', '09:00', '32', '1', '')).toThrow()
  })
  it('keeps custom permissions configurable without comma-separated code', () => {
    expect(validateAppScope(' files:write ', [])).toBe('files:write')
    for (const value of ['', 'runs:*', 'a'.repeat(65), 'runs:read']) expect(() => validateAppScope(value, ['runs:read'])).toThrow()
  })
  it('checks configuration files before import', async () => {
    await expect(configurationFileText({ size: 10, text: async () => '{"openapi":"3.0.0"}' })).resolves.toContain('openapi')
    for (const content of ['null', '[]', 'bad']) await expect(configurationFileText({ size: 10, text: async () => content })).rejects.toThrow('JSON')
    await expect(configurationFileText({ size: 1048577, text: async () => '{}' })).rejects.toThrow('1 MB')
  })
})
