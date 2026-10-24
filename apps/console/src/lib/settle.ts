import { toast } from 'sonner'

/**
 * 所有不 await 的 Promise 统一用 `.catch(onReject(...))` 收尾（eslint no-floating-promises, ignoreVoid: false）。
 * - `{ warn: label }`：后台动作（列表刷新、自动跳转），失败不打扰用户，只在控制台留一行。
 * - `{ toast: message }`：用户点出来的动作，失败要让用户知道；只显示给定的固定文案，不回显错误原文。
 */
export type RejectNotice = { warn: string } | { toast: string }

export function onReject(notice: RejectNotice): (error: unknown) => void {
  return (error) => {
    if ('toast' in notice) {
      toast.error(notice.toast)
      return
    }
    const detail = error instanceof Error ? error.message : safeString(error)
    console.warn(`[forge] ${notice.warn}: ${detail.replace(/\s+/g, ' ').trim()}`)
  }
}

function safeString(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
