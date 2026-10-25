import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { ApiError } from './api'
import { handleDialogServerError, handleServerError } from './handle-server-error'

const sticky = { duration: Infinity, closeButton: true }

// FE-R6 P3：/next/ 401 时全局 unauthorized handler 已弹「登录已过期」并跳 /sign-in，
// handleServerError 不能再叠一条常驻的「未登录 / 错误码」toast。
describe('handleServerError', () => {
  beforeEach(() => toastError.mockClear())

  it('401 → 不出 toast（交给全局 401 处理）', () => {
    handleServerError(new ApiError('未登录', 401, 'AUTH-1001'))
    expect(toastError).not.toHaveBeenCalled()
  })

  it('401 不带错误码 → 同样不出 toast', () => {
    handleServerError(new ApiError('未登录', 401))
    expect(toastError).not.toHaveBeenCalled()
  })

  it('403 → 行为不变：原文案 + 错误码，常驻', () => {
    handleServerError(new ApiError('角色缺少权限: agent.publish', 403, 'AUTH-1003'))
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('角色缺少权限: agent.publish', { description: '错误码 AUTH-1003', ...sticky })
  })

  it.each([500, 502, 503])('%s → 行为不变：原文案 + 错误码，常驻', (status) => {
    handleServerError(new ApiError('服务内部错误', status, 'SYS-5000'))
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('服务内部错误', { description: '错误码 SYS-5000', ...sticky })
  })

  it('无错误码的 5xx → 不带 description', () => {
    handleServerError(new ApiError('服务内部错误', 500))
    expect(toastError).toHaveBeenCalledWith('服务内部错误', { description: undefined, ...sticky })
  })

  it('非 ApiError（网络错误等）→ 行为不变', () => {
    handleServerError(new TypeError('Failed to fetch'))
    expect(toastError).toHaveBeenCalledWith('Failed to fetch', { description: undefined, ...sticky })
    handleServerError(undefined)
    expect(toastError).toHaveBeenLastCalledWith('出了点问题，请稍后再试', { description: undefined, ...sticky })
  })

  it('handleDialogServerError：401 只关框不出 toast，5xx 保留框并出 toast（行为不变）', () => {
    const close = vi.fn()
    handleDialogServerError(new ApiError('未登录', 401, 'AUTH-1001'), close)
    expect(close).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
    const close2 = vi.fn()
    handleDialogServerError(new ApiError('服务内部错误', 500, 'SYS-5000'), close2)
    expect(close2).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith('服务内部错误', { description: '错误码 SYS-5000', ...sticky })
  })
})
