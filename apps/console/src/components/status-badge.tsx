import { cn } from '@/lib/utils'

type Tone = 'success' | 'info' | 'warning' | 'destructive' | 'neutral'

const TONE: Record<string, Tone> = {
  succeeded: 'success', enabled: 'success', active: 'success', approved: 'success', published: 'success',
  queued: 'info', running: 'info', low: 'info',
  waiting_approval: 'warning', awaiting_approval: 'warning', pending: 'warning', disabled: 'warning', draft: 'warning', medium: 'warning',
  failed: 'destructive', rejected: 'destructive', expired: 'destructive', budget_exhausted: 'destructive', high: 'destructive', critical: 'destructive',
  cancelled: 'neutral',
}

const LABEL: Record<string, string> = {
  succeeded: '成功', active: '启用', enabled: '启用', approved: '已批准', published: '已发布',
  queued: '排队中', running: '运行中', waiting_approval: '待审批', awaiting_approval: '待审批', pending: '待审批', disabled: '已停用', draft: '草稿',
  failed: '失败', rejected: '已驳回', expired: '已过期', budget_exhausted: '预算耗尽', cancelled: '已取消',
  low: '低风险', medium: '中风险', high: '高风险', critical: '严重',
}

const STYLE: Record<Tone, string> = {
  success: 'bg-emerald-500/10 text-emerald-700 ring-emerald-600/20 dark:text-emerald-400',
  info: 'bg-sky-500/10 text-sky-700 ring-sky-600/20 dark:text-sky-400',
  warning: 'bg-amber-500/10 text-amber-700 ring-amber-600/20 dark:text-amber-400',
  destructive: 'bg-red-500/10 text-red-700 ring-red-600/20 dark:text-red-400',
  neutral: 'bg-muted text-muted-foreground ring-border',
}

export function StatusBadge({ status, label, tone }: { status: string; label?: string; tone?: Tone }) {
  const t = tone ?? TONE[status] ?? 'neutral'
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset', STYLE[t])}>
      <span className={cn('size-1.5 rounded-full bg-current', status === 'running' && 'animate-pulse')} />
      {label ?? LABEL[status] ?? status}
    </span>
  )
}
