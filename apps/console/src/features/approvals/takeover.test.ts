import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { toastError, toastNeutral, toastSuccess, toastInfo } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastNeutral: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: Object.assign(toastNeutral, { error: toastError, success: toastSuccess, info: toastInfo }) }))

import { ApiError } from '@/lib/api'
import { handleDialogServerError, handleServerError } from '@/lib/handle-server-error'
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

  it('reason=interrupted、attempt=3 → 徽标 +「第 3 次执行被中断」', () => {
    expect(view({ reason: 'interrupted', attempt: 3 })).toEqual({ badge: '执行中断，可能已执行过', attempt: '第 3 次执行被中断' })
  })

  it('reason=interrupted、attempt=1 → 「第 1 次执行被中断」（attempt 是被中断那次执行的序号，不加 1）', () => {
    expect(view({ reason: 'interrupted', attempt: 1 })).toEqual({ badge: '执行中断，可能已执行过', attempt: '第 1 次执行被中断' })
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

  it.each(['approved', 'rejected'])('409 RUN-7005（审批仍 pending，Run 已结束；%s）→ 「Run 已结束，此审批已失效」，关框并刷新，不弹后端原文', () => {
    const { close, refresh } = run(new ApiError('Run 已结束，审批不可操作', 409, 'RUN-7005'))
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('Run 已结束，此审批已失效', { description: '错误码 RUN-7005', ...sticky })
    expect(close).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('护栏：非 409 的 RUN-7005 不当作审批失效', () => {
    const { close, refresh } = run(new ApiError('参数错误', 400, 'RUN-7005'))
    expect(toastError).toHaveBeenCalledWith('参数错误', { description: '错误码 RUN-7005', ...sticky })
    expect(close).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
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

describe('护栏：审批以外的操作收到 409 RUN-7005 照旧走通用错误提示', () => {
  beforeEach(() => toastError.mockClear())

  it('handleServerError（通用 mutation / 查询）→ 后端原文 + 错误码，不弹「已失效」', () => {
    handleServerError(new ApiError('Run 已结束，不能取消', 409, 'RUN-7005'))
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('Run 已结束，不能取消', { description: '错误码 RUN-7005', ...sticky })
    expect(JSON.stringify(toastError.mock.calls)).not.toContain('已失效')
  })

  it('handleDialogServerError（其他确认框）→ 后端原文 + 错误码，保留确认框', () => {
    const close = vi.fn()
    handleDialogServerError(new ApiError('Run 已结束，不能取消', 409, 'RUN-7005'), close)
    expect(toastError).toHaveBeenCalledWith('Run 已结束，不能取消', { description: '错误码 RUN-7005', ...sticky })
    expect(close).not.toHaveBeenCalled()
  })
})

describe('码集合只定义一处', () => {
  it('APPROVAL_STALE_CODES = {APR-2104, APR-2103, RUN-7005}（APR-2103 兜底），不含 CFG-8503；RUN-7005 文案固定', () => {
    const codes = mod.APPROVAL_STALE_CODES as ReadonlySet<string> | undefined
    expect(codes ? [...codes] : null).toEqual(['APR-2104', 'APR-2103', 'RUN-7005'])
    expect(mod.APPROVAL_RUN_FINISHED_TOAST).toBe('Run 已结束，此审批已失效')
    expect(codes?.has('CFG-8503')).toBe(false)
  })
})

/**
 * SSE approval.resolved（Run 终态时后端把挂着的 pending 审批改成 expired）：/next/ 与旧版行为一致。
 * - status=expired：approvalId 在当前列表里 → 移除（或刷新）；该审批的确认框开着 → 关掉并给中性轻提示「此审批已失效」；
 *   当前页面没有这个审批 → 静默忽略。不弹 error、不写 console.error。
 * - 其他 status 保持现状（不处理）；未知 status / 缺字段容错，不抛异常。
 * 注：/next/ 目前没有任何 SSE 订阅，这个处理函数先做成纯逻辑并测试，待确认是否在审批页新增订阅后再接线。
 */
describe('handleApprovalResolved：approval.resolved 事件', () => {
  type On = { has: (id: string) => boolean; remove: (id: string) => void; dialogApprovalId: string | null; closeDialog: () => void }
  const handle = (data: unknown, on: On) => fn<(d: unknown, o: On) => void>('handleApprovalResolved')(data, on)
  const X = 'apr_01M5PK6G1GPZ3APBN3QNXR'
  const Y = 'apr_01M5PK6G1GPZ3APBN3QNXS'
  const setup = (ids: string[], dialogApprovalId: string | null = null) => {
    const on = { has: vi.fn((id: string) => ids.includes(id)), remove: vi.fn(), dialogApprovalId, closeDialog: vi.fn() }
    return on
  }
  const noToast = () => {
    expect(toastError).not.toHaveBeenCalled()
    expect(toastNeutral).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastInfo).not.toHaveBeenCalled()
  }
  let consoleError: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    toastError.mockReset(); toastNeutral.mockReset(); toastSuccess.mockReset(); toastInfo.mockReset()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { expect(consoleError).not.toHaveBeenCalled(); consoleError.mockRestore() })

  it('文案常量与旧版一致：「此审批已失效」', () => {
    expect(mod.APPROVAL_RESOLVED_EXPIRED_TOAST).toBe('此审批已失效')
  })

  it('expired 且在列表里：移除，不提示，不关框', () => {
    const on = setup([X, Y])
    handle({ approvalId: X, status: 'expired' }, on)
    expect(on.remove).toHaveBeenCalledWith(X)
    expect(on.remove).toHaveBeenCalledTimes(1)
    expect(on.closeDialog).not.toHaveBeenCalled()
    noToast()
  })

  it('expired 且该审批的确认框开着：关框 + 中性轻提示「此审批已失效」（不是 error），并移除', () => {
    const on = setup([X], X)
    handle({ approvalId: X, status: 'expired' }, on)
    expect(on.closeDialog).toHaveBeenCalledTimes(1)
    expect(on.remove).toHaveBeenCalledWith(X)
    expect(toastNeutral).toHaveBeenCalledWith('此审批已失效')
    expect(toastNeutral).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('开着的是另一条的确认框：不关、不提示，只移除这一条', () => {
    const on = setup([X, Y], Y)
    handle({ approvalId: X, status: 'expired' }, on)
    expect(on.closeDialog).not.toHaveBeenCalled()
    expect(on.remove).toHaveBeenCalledWith(X)
    noToast()
  })

  it('approvalId 不在当前页面：静默忽略', () => {
    const on = setup([Y])
    handle({ approvalId: X, status: 'expired' }, on)
    expect(on.remove).not.toHaveBeenCalled()
    expect(on.closeDialog).not.toHaveBeenCalled()
    noToast()
  })

  it.each(['approved', 'rejected', 'pending', 'weird-status'])('status=%s：保持现状，不处理', (status) => {
    const on = setup([X], X)
    expect(() => handle({ approvalId: X, status }, on)).not.toThrow()
    expect(on.remove).not.toHaveBeenCalled()
    expect(on.closeDialog).not.toHaveBeenCalled()
    noToast()
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['字符串', 'expired'],
    ['缺 approvalId', { status: 'expired' }],
    ['approvalId 不是字符串', { approvalId: 42, status: 'expired' }],
    ['缺 status', { approvalId: X }],
  ])('data=%s：不抛异常，不处理', (_label, data) => {
    const on = setup([X], X)
    expect(() => handle(data, on)).not.toThrow()
    expect(on.remove).not.toHaveBeenCalled()
    expect(on.closeDialog).not.toHaveBeenCalled()
    noToast()
  })
})
