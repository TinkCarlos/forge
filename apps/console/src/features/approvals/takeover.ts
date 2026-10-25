import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { handleDialogServerError } from '@/lib/handle-server-error'

/** R9：Worker 接手中断后转人工确认的审批（reason=interrupted）。reason 缺失（老后端）或未知值一律按 policy 处理。 */
export const INTERRUPTED_BADGE = '执行中断，可能已执行过'

/**
 * 批准/驳回一条已处理、已被接手替换、已过期或并发输掉的审批：409 + 其中一个码（APR-2104 审批已处理或已过期，APR-2103 并发决定，
 * RUN-7005 审批仍 pending 但所属 Run 已结束）。码集合只在这一行定义，只给审批操作（handleDecideError）用；
 * 其他操作收到 RUN-7005 照旧走 handleServerError。CFG-8503 是通用「资源状态冲突」，不在集合里，照普通错误提示。
 * 后端统一用 APR-2104，APR-2103 仅作兜底。
 */
export const APPROVAL_STALE_CODES: ReadonlySet<string> = new Set(['APR-2104', 'APR-2103', 'RUN-7005'])
export const APPROVAL_STALE_TOAST = '该审批已失效，请刷新后处理新的审批'
/** RUN-7005 的专门文案（和旧版控制台一致）。 */
export const APPROVAL_RUN_FINISHED_TOAST = 'Run 已结束，此审批已失效'

export type ApprovalReason = 'policy' | 'interrupted'

export function approvalReason(a: { reason?: unknown }): ApprovalReason {
  return a.reason === 'interrupted' ? 'interrupted' : 'policy'
}

/** 中断审批的徽标和「第 N 次执行被中断」（N = attempt，被中断那次执行的序号，不加 1；不是正整数时为 null）；policy 返回 null，和原来一样不显示。 */
export function approvalTakeover(a: { reason?: unknown; attempt?: unknown }): { badge: string; attempt: string | null } | null {
  if (approvalReason(a) !== 'interrupted') return null
  const n = a.attempt
  return { badge: INTERRUPTED_BADGE, attempt: typeof n === 'number' && Number.isInteger(n) && n > 0 ? `第 ${n} 次执行被中断` : null }
}

/**
 * 批准/驳回失败：409 + APPROVAL_STALE_CODES 弹专门提示（保留到手动关闭，带错误码），关确认框并刷新列表；
 * 其他错误照旧走 handleDialogServerError，其他 409 照旧刷新列表。
 */
export function handleDecideError(error: unknown, on: { close: () => void; refresh: () => void }) {
  if (error instanceof ApiError && error.status === 409 && !!error.code && APPROVAL_STALE_CODES.has(error.code)) {
    toast.error(error.code === 'RUN-7005' ? APPROVAL_RUN_FINISHED_TOAST : APPROVAL_STALE_TOAST, { description: `错误码 ${error.code}`, duration: Infinity, closeButton: true })
    on.close()
    on.refresh()
    return
  }
  handleDialogServerError(error, on.close)
  if (error instanceof ApiError && error.status === 409) on.refresh()
}
