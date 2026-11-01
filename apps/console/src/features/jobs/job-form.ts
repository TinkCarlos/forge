import type { JobTarget } from '../../../../../packages/contracts/src/job-api'
import type { JobManifest } from '../../../../../packages/contracts/src/job-definitions'

export const jobLimitFields = [
  { key: 'maxConcurrentExecutions', label: '同时执行的任务数', min: 1, max: 20, hint: '同一个任务最多同时运行多少次。' },
  { key: 'maxParallelItems', label: '同时处理的明细数', min: 1, max: 16, hint: '一次执行中并行处理的明细数量。' },
  { key: 'maxCostUsd', label: '单次预算（美元）', min: 0.000001, max: 10000, hint: '达到预算后停止继续调用模型。' },
  { key: 'maxAttempts', label: '最多尝试次数', min: 1, max: 5, hint: '包含第一次执行；填 1 表示不重试。' },
  { key: 'stepTimeoutSeconds', label: '单步超时（秒）', min: 1, max: 86400, hint: '一个步骤最多允许执行的时间。' },
  { key: 'activeTimeoutSeconds', label: '执行超时（秒）', min: 1, max: 604800, hint: '任务实际执行的总时间上限。' },
  { key: 'waitTimeoutSeconds', label: '等待超时（秒）', min: 60, max: 7776000, hint: '等待审批、人工处理等的时间上限。' },
] as const

export function selectJobTarget(target: JobTarget, current?: JobManifest): JobManifest {
  return {
    ...current,
    schemaVersion: 1,
    target: { kind: target.kind, key: target.key, version: target.version, checksum: target.checksum },
    inputSchema: target.inputSchema as JobManifest['inputSchema'],
    outputSchema: target.outputSchema as JobManifest['outputSchema'],
    nodes: current?.nodes ?? [],
    limits: current?.limits ?? { maxConcurrentExecutions: 1, maxParallelItems: 2, stepTimeoutSeconds: 300, activeTimeoutSeconds: 3600, waitTimeoutSeconds: 604800, maxAttempts: 2, maxCostUsd: '1.000000' },
  }
}

export function costWithSixDecimals(value: string): string {
  if (!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,6})?$/.test(value)) throw new Error('预算请输入最多 6 位小数的金额')
  const [whole, fraction = ''] = value.split('.')
  return `${whole}.${fraction.padEnd(6, '0')}`
}
