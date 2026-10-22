import { toast } from 'sonner'
import { ApiError } from '@/lib/api'

/** 错误 toast：保留到手动关闭，并带上错误码（DESIGN.md §9）。 */
export function handleServerError(error: unknown) {
  const message = error instanceof Error ? error.message : '出了点问题，请稍后再试'
  const code = error instanceof ApiError ? error.code : undefined
  toast.error(message, { description: code ? `错误码 ${code}` : undefined, duration: Infinity, closeButton: true })
}
