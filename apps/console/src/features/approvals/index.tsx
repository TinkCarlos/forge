import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ExternalLink, MoreHorizontal, X, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { onReject } from '@/lib/settle'
import { api } from '@/lib/api'
import { idSeg } from '@/lib/entity-id'
import { useCan } from '@/hooks/use-can'
import { useRefreshOnVisible } from '@/hooks/use-refresh-on-visible'
import { shortTime } from '@/lib/format'
import { clampPage, pageCount, showPager } from '@/lib/pagination'
import { LEGACY_LINK_ATTRS, LEGACY_LINK_HINT, legacyRunHref } from '@/lib/legacy-link'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageShell } from '@/components/layout/page-shell'
import { rowMotion } from '@/components/motion/page'
import { StatusBadge } from '@/components/status-badge'
import { type SkeletonCol, SkeletonRows, TableError, TableMessage } from '@/components/table-states'
import { type Approval, approvalsQuery } from './api'
import { approvalTakeover, handleDecideError, INTERRUPTED_BADGE } from './takeover'

type Decision = { approval: Approval; decision: 'approved' | 'rejected' } | null

const MotionRow = motion.create(TableRow)
const COLS = 6
const APPROVAL_SKELETON: SkeletonCol[] = [
  { kind: 'title' },
  { kind: 'code', label: '工具与参数' },
  { kind: 'badge', label: '风险' },
  { kind: 'text', label: '提交时间' },
  { kind: 'text', label: '过期时间' },
  { kind: 'actions' },
]
const SIZE = 20

/** args_preview：null 表示没有工具调用，空字符串表示调用时没有参数，都显示「无参数」。 */
function ArgsPreview({ value }: { value?: string | null }) {
  if (!value) return <span className='block text-xs leading-4 text-muted-foreground'>无参数</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <code title={value} className='block max-w-72 truncate rounded max-lg:max-w-[60vw] bg-muted px-1.5 font-mono text-xs leading-4'>{value}</code>
      </TooltipTrigger>
      <TooltipContent className='max-w-md font-mono text-xs break-all'>{value}</TooltipContent>
    </Tooltip>
  )
}

/** Run ID 是 ULID，前 8 位是时间戳、同批数据都一样，所以显示后 8 位，完整值可复制。 */
function RunId({ id }: { id: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      toast.success('已复制 Run ID')
    } catch {
      toast.error('复制失败，请手动选择')
    }
  }
  return (
    <div className='flex items-center gap-1 font-mono text-xs leading-4 text-muted-foreground'>
      <span title={id}>Run …{id.slice(-8)}</span>
      <button
        type='button'
        onClick={copy}
        aria-label={`复制 Run ID ${id}`}
        className='hit-area relative inline-flex size-4 items-center justify-center rounded-sm opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'
      >
        <Copy className='size-3' />
      </button>
    </div>
  )
}

export function Approvals() {
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const { data, error, isPending, isPlaceholderData, refetch } = useQuery(approvalsQuery(page, SIZE))
  // 还没有审批的实时推送：切回标签页时刷新一次当前页（2 秒内不重复，不轮询）；失败沿用下面的 TableError，不另弹 toast
  useRefreshOnVisible(() => refetch())
  const [pending, setPending] = useState<Decision>(null)
  const [comment, setComment] = useState('')
  // K-29：没有 approval.decide（如 auditor）时只读，不显示批准/驳回
  const canDecide = useCan('approval.decide')
  const canViewRun = useCan('run.view')

  const decide = useMutation({
    mutationFn: (d: NonNullable<Decision>) =>
      api(`/admin/api/approvals/${idSeg(d.approval.id)}/decide`, { method: 'POST', body: { decision: d.decision, comment } }),
    onSuccess: (_, d) => {
      toast.success(d.decision === 'approved' ? '已批准，Run 会继续执行' : '已驳回，Run 不会执行这次调用')
      setPending(null)
      qc.invalidateQueries({ queryKey: ['approvals'] }).catch(onReject({ warn: 'approvals: refresh after decide' }))
    },
    onError: (err) =>
      handleDecideError(err, {
        close: () => setPending(null),
        refresh: () => qc.invalidateQueries({ queryKey: ['approvals'] }).catch(onReject({ warn: 'approvals: refresh after conflict' })),
      }),
  })

  const open = (approval: Approval, decision: 'approved' | 'rejected') => {
    setComment('')
    setPending({ approval, decision })
  }

  const total = data?.total ?? 0
  const pages = pageCount(total, SIZE)
  // K-30：处理掉当前页最后一条后，当前页超出总页数 → 回到最后一页（而不是停在空页上）
  const clamped = data && !isPlaceholderData ? clampPage(page, total, SIZE) : page
  useEffect(() => {
    if (clamped !== page) setPage(clamped)
  }, [clamped, page])
  const tool = (a: Approval) => a.tool_name || '工具'

  return (
    <PageShell title='审批中心' description='Agent 调用高风险工具时会暂停，等你批准或驳回。'>
      <div className='table-cards overflow-hidden rounded-lg border bg-card'>
        <Table>
          <TableHeader className='bg-muted/40'>
            <TableRow className='hover:bg-transparent'>
              <TableHead className='w-[200px] max-w-[200px]'>Agent</TableHead>
              <TableHead>工具与参数</TableHead>
              <TableHead>风险</TableHead>
              <TableHead>提交时间</TableHead>
              <TableHead>过期时间</TableHead>
              <TableHead className='w-44'><span className='sr-only'>操作</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {error ? (
              <TableError cols={COLS} error={error} onRetry={() => refetch().catch(onReject({ toast: '重试失败，请稍后再试' }))} />
            ) : isPending || clamped !== page ? (
              <SkeletonRows cols={APPROVAL_SKELETON} />
            ) : data.items.length === 0 ? (
              <TableMessage cols={COLS} kind='empty' title='没有待审批的调用' hint='Agent 调用高风险工具时会暂停，等你在这里批准或驳回。' />
            ) : (
              data.items.map((a, i) => {
                const created = shortTime(a.created_at)
                const expires = shortTime(a.expires_at)
                const takeover = approvalTakeover(a)
                return (
                  <MotionRow key={a.id} {...rowMotion(i)} className='h-13 [&>td]:py-2'>
                    <TableCell>
                      <div className='truncate font-medium lg:max-w-[184px]' title={a.agent_name}>{a.agent_name}</div>
                      <RunId id={a.run_id} />
                    </TableCell>
                    <TableCell data-label='工具与参数' className='max-lg:items-start'>
                      <div className='min-w-0 max-lg:flex max-lg:flex-col max-lg:items-end max-lg:gap-1'>
                      <div className='font-mono text-sm whitespace-nowrap'>{a.tool_name ?? '—'}</div>
                      <ArgsPreview value={a.args_preview} />
                      </div>
                    </TableCell>
                    <TableCell data-label='风险'>
                      <div className='flex flex-wrap items-center gap-1.5 max-lg:justify-end'>
                        <StatusBadge status={a.risk_level} />
                        {takeover && <StatusBadge status='interrupted' tone='warning' label={takeover.badge} />}
                        {takeover?.attempt && <span className='text-xs text-muted-foreground tabular-nums'>{takeover.attempt}</span>}
                      </div>
                    </TableCell>
                    <TableCell data-label='提交时间' className='tabular-nums' title={created.title}>{created.text}</TableCell>
                    <TableCell data-label='过期时间' className='tabular-nums' title={expires.title}>{expires.text}</TableCell>
                    <TableCell data-actions>
                      <div className='flex items-center justify-end gap-1'>
                        {canDecide && (
                          <Button size='sm' variant='outline' onClick={() => open(a, 'approved')}>
                            <Check /> 批准
                          </Button>
                        )}
                        {(canDecide || canViewRun) && <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant='ghost' size='icon' className='size-8 data-[state=open]:bg-muted' aria-label={`审批 ${a.id.slice(0, 8)} 更多操作`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align='end' className='w-44'>
                            {canDecide && (
                              <>
                                <DropdownMenuItem variant='destructive' onClick={() => open(a, 'rejected')}>
                                  <X /> 驳回
                                </DropdownMenuItem>
                                {canViewRun && <DropdownMenuSeparator />}
                              </>
                            )}
                            {canViewRun && <DropdownMenuItem asChild>
                              <a href={legacyRunHref(a.run_id)} {...LEGACY_LINK_ATTRS} title={LEGACY_LINK_HINT}><ExternalLink /> 查看本次 Run</a>
                            </DropdownMenuItem>}
                          </DropdownMenuContent>
                        </DropdownMenu>}
                      </div>
                    </TableCell>
                  </MotionRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {showPager(total, page) && (
        <div className='flex items-center justify-between text-sm text-muted-foreground'>
          <span>共 {total} 条</span>
          <div className='flex items-center gap-2'>
            <Button variant='outline' size='sm' disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
            <span className='tabular-nums'>第 {page} / {pages} 页</span>
            <Button variant='outline' size='sm' disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        destructive={pending?.decision === 'rejected'}
        title={pending ? `${pending.decision === 'approved' ? '批准' : '驳回'}「${pending.approval.agent_name}」调用「${tool(pending.approval)}」` : ''}
        desc={
          pending?.decision !== 'approved'
            ? '驳回后 Run 不会执行这次工具调用，驳回后不能撤回。'
            : approvalTakeover(pending.approval)
              ? `这次调用${INTERRUPTED_BADGE}。批准会再执行一次，批准后不能撤回。`
              : '批准后 Run 会立即继续执行这次工具调用，批准后不能撤回。'
        }
        confirmText={pending?.decision === 'approved' ? '确认批准' : '确认驳回'}
        isLoading={decide.isPending}
        handleConfirm={() => pending && decide.mutate(pending)}
      >
        {pending && (
          <div className='grid gap-4'>
            <div className='rounded-md border bg-muted/40 p-3 text-sm'>
              <p className='mb-2'>审批原因：{approvalTakeover(pending.approval) ? '工具执行中断，结果不确定，需要人工确认是否再次执行。' : `工具风险等级为「${pending.approval.risk_level}」，按策略暂停等待确认。`}</p>
              <p className='mb-2 text-muted-foreground'>到期时间：{pending.approval.expires_at ? shortTime(pending.approval.expires_at).title : '未设置'}</p>
              {canViewRun && <a className='mb-3 inline-flex items-center gap-1 underline underline-offset-4' href={legacyRunHref(pending.approval.run_id)} {...LEGACY_LINK_ATTRS} title={LEGACY_LINK_HINT}><ExternalLink className='size-4' />查看原始请求、消息与工具记录</a>}
              <div className='mb-1 text-xs text-muted-foreground'>调用参数（已脱敏）</div>
              {pending.approval.args_preview ? (
                <code className='font-mono text-xs break-all'>{pending.approval.args_preview}</code>
              ) : (
                <span className='text-muted-foreground'>无参数</span>
              )}
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='approval-comment'>备注（可选）</Label>
              <Textarea id='approval-comment' rows={3} value={comment} onChange={(e) => setComment(e.target.value)} className='resize-none' />
            </div>
          </div>
        )}
      </ConfirmDialog>
    </PageShell>
  )
}
