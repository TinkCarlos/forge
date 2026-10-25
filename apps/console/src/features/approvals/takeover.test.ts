import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { ApiError } from '@/lib/api'
import * as takeover from './takeover'

/**
 * R9：/next/ 审批中心的 Worker 接手中断显示与 409 审批失效（APR-2104 / APR-2103）处理（纯逻辑，组件只取这些结果渲染）。
 */
const sticky = { duration: Infinity, closeButton: true }
const mod = takeover as Record<string, unknown>
const fn = <T>(name: string) => {
  const f = mod[name]
  if (typeof f !== 'function') throw new Error(`takeover.${name} 未实现`)
  return f as T
}

describe('approvalTakeover：中断徽标与尝试次数', () => {
  const view = (a: Record<string, unknown>) => fn<(a: Record<string, unknown>) => { badge: string; attempt: string | null } | null>('approvalTakeover')(a)

  it('reason=interrupted、attempt=3 → 徽标 +「第 3 次尝试」', () => {
    expect(view({ reason: 'interrupted', attempt: 3 })).toEqual({ badge: '执行中断，可能已执行过', attempt: '第 3 次尝试' })
  })

  it('reason=interrupted、attempt=null → 有徽标，没有次数', () => {
    expect(view({ reason: 'interrupted', attempt: null })).toEqual({ badge: '执行中断，可能已执行过', attempt: null })
  })

  it('reason=policy → 不显示', () => {
    expect(view({ reason: 'policy', attempt: null })).toBeNull()
  })

  it('reason 缺失（老后端）→ 按 policy，不显示', () => {
    expect(view({})).toBeNull()
  })

  it('未知 reason / 非正整数 attempt → 不显示徽标或次数（不把后端原文当文案）', () => {
    expect(view({ reason: '<script>', attempt: 2 })).toBeNull()
    expect(view({ reason: 'interrupted', attempt: '2' })).toEqual({ badge: '执行中断，可能已执行过', attempt: null })
    expect(view({ reason: 'interrupted', attempt: 0 })).toEqual({ badge: '执行中断，可能已执行过', attempt: null })
  })
})

describe('handleDecideError：409 APR-2104 / APR-2103 专门提示并刷新', () => {
  beforeEach(() => toastError.mockClear())
  const run = (err: unknown) => {
    const close = vi.fn()
    const refresh = vi.fn()
    fn<(e: unknown, on: { close: () => void; refresh: () => void }) => void>('handleDecideError')(err, { close, refresh })
    return { close, refresh }
  }

  it.each(['APR-2104', 'APR-2103'])('409 %s → 「该审批已失效，请刷新后处理新的审批」，关框并刷新，不弹后端原文', (code) => {
    const { close, refresh } = run(new ApiError('审批已处理或已过期', 409, code))
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('该审批已失效，请刷新后处理新的审批', { description: `错误码 ${code}`, ...sticky })
    expect(close).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('护栏：409 CFG-8503（通用资源状态冲突）→ 普通错误提示，保留确认框，按原有 409 逻辑刷新', () => {
    const { close, refresh } = run(new ApiError('资源状态冲突', 409, 'CFG-8503'))
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('资源状态冲突', { description: '错误码 CFG-8503', ...sticky })
    expect(close).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('其他 409（RUN-7005）→ 照旧：原文 + 错误码，保留确认框，刷新列表（原有行为）', () => {
    const { close, refresh } = run(new ApiError('Run 已结束，审批不可操作', 409, 'RUN-7005'))
    expect(toastError).toHaveBeenCalledWith('Run 已结束，审批不可操作', { description: '错误码 RUN-7005', ...sticky })
    expect(close).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('500 → 照旧：原文 + 错误码，保留确认框，不刷新', () => {
    const { close, refresh } = run(new ApiError('服务内部错误', 500, 'SYS-5000'))
    expect(toastError).toHaveBeenCalledWith('服务内部错误', { description: '错误码 SYS-5000', ...sticky })
    expect(close).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('非 409 的 APR-2104 不当作审批失效', () => {
    const { refresh } = run(new ApiError('参数错误', 400, 'APR-2104'))
    expect(toastError).toHaveBeenCalledWith('参数错误', { description: '错误码 APR-2104', ...sticky })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('401 → 只关框，不出 toast（原有行为）', () => {
    const { close } = run(new ApiError('未登录', 401, 'AUTH-1001'))
    expect(close).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })
})

describe('码集合只定义一处', () => {
  it('APPROVAL_STALE_CODES = {APR-2104, APR-2103}，不含 CFG-8503', () => {
    const codes = mod.APPROVAL_STALE_CODES as ReadonlySet<string> | undefined
    expect(codes ? [...codes] : null).toEqual(['APR-2104', 'APR-2103'])
    expect(codes?.has('CFG-8503')).toBe(false)
  })
})
