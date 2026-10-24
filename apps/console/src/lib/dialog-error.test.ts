import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { FORBIDDEN_TOAST, dialogErrorOutcome, handleDialogError } from './dialog-error'

describe('K-11 / UI-095 确认框内操作出错', () => {
  it('403 → 关闭确认框，提示「没有权限」', () => {
    expect(dialogErrorOutcome(new ApiError('角色缺少权限: agent.publish', 403, 'AUTH-1003'))).toBe('forbidden')
    expect(FORBIDDEN_TOAST).toBe('没有权限')
  })
  it('401 → 关闭确认框（跳登录由全局 401 处理，不再额外弹）', () => {
    expect(dialogErrorOutcome(new ApiError('未登录', 401, 'AUTH-1001'))).toBe('unauthorized')
  })
  it.each([409, 500, 502, 503])('%s → 保留确认框方便重试', (status) => {
    expect(dialogErrorOutcome(new ApiError('x', status))).toBe('keep')
  })
  it('网络错误（非 ApiError）→ 保留', () => {
    expect(dialogErrorOutcome(new TypeError('Failed to fetch'))).toBe('keep')
    expect(dialogErrorOutcome(undefined)).toBe('keep')
  })
  it('handleDialogError：403 关框 + 固定文案 toast，不走通用错误', () => {
    const close = vi.fn(), forbidden = vi.fn(), other = vi.fn()
    handleDialogError(new ApiError('角色缺少权限: agent.publish', 403, 'AUTH-1003'), { close, forbidden, other })
    expect(close).toHaveBeenCalledTimes(1)
    expect(forbidden).toHaveBeenCalledWith(FORBIDDEN_TOAST, 'AUTH-1003')
    expect(other).not.toHaveBeenCalled()
  })
  it('handleDialogError：401 只关框', () => {
    const close = vi.fn(), forbidden = vi.fn(), other = vi.fn()
    handleDialogError(new ApiError('未登录', 401), { close, forbidden, other })
    expect(close).toHaveBeenCalledTimes(1)
    expect(forbidden).not.toHaveBeenCalled()
    expect(other).not.toHaveBeenCalled()
  })
  it('handleDialogError：5xx 不关框，交给通用错误提示', () => {
    const close = vi.fn(), forbidden = vi.fn(), other = vi.fn()
    const err = new ApiError('boom', 500)
    handleDialogError(err, { close, forbidden, other })
    expect(close).not.toHaveBeenCalled()
    expect(other).toHaveBeenCalledWith(err)
  })
})
