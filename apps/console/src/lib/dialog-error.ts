import { ApiError } from './api'

/** K-11 / UI-095：确认框里的操作收到 401/403 时关闭确认框（重试也没用）；5xx、409、网络错误保留确认框方便重试。 */
export const FORBIDDEN_TOAST = '没有权限'

export type DialogErrorOutcome = 'forbidden' | 'unauthorized' | 'keep'

export function dialogErrorOutcome(error: unknown): DialogErrorOutcome {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'forbidden'
    if (error.status === 401) return 'unauthorized'
  }
  return 'keep'
}

export function handleDialogError(
  error: unknown,
  on: { close: () => void; forbidden: (message: string, code?: string) => void; other: (error: unknown) => void }
) {
  const outcome = dialogErrorOutcome(error)
  if (outcome === 'keep') return on.other(error)
  on.close()
  // 401：全局 unauthorized handler 已经弹「登录已过期」并跳登录页，这里不重复提示。
  if (outcome === 'forbidden') on.forbidden(FORBIDDEN_TOAST, error instanceof ApiError ? error.code : undefined)
}
