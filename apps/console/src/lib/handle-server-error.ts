import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { handleDialogError } from '@/lib/dialog-error'

/** 错误 toast：保留到手动关闭，并带上错误码（DESIGN.md §9）。
 * 401 不出 toast：全局 unauthorized handler（main.tsx）已提示「登录已过期」并跳 /sign-in，避免叠一条常驻的「未登录」。 */
export function handleServerError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) return
  const message = error instanceof Error ? error.message : '出了点问题，请稍后再试'
  const code = error instanceof ApiError ? error.code : undefined
  toast.error(message, { description: code ? `错误码 ${code}` : undefined, duration: Infinity, closeButton: true })
}

/** 确认框里的 mutation 用：401/403 关框（403 弹「没有权限」+ 错误码），其它错误保留确认框并走 handleServerError。 */
export function handleDialogServerError(error: unknown, close: () => void) {
  handleDialogError(error, {
    close,
    forbidden: (message, code) =>
      toast.error(message, { description: code ? `错误码 ${code}` : undefined, duration: Infinity, closeButton: true }),
    other: handleServerError,
  })
}
