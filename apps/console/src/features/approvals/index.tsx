import { useState } from 'react'
import { motion } from 'motion/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ExternalLink, MoreHorizontal, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { shortTime } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
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
import { SkeletonRows, TableMessage } from '@/components/table-states'
import { type Approval, approvalsQuery } from './api'

type Decision = { approval: Approval; decision: 'approved' | 'rejected' } | null

const MotionRow = motion.create(TableRow)
const COLS = 6
const SIZE = 20

/** args_preview：null 表示没有工具调用，空字符串表示调用时没有参数，都显示「无参数」。 */
function ArgsPreview({ value }: { value?: string | null }) {
  if (!value) return <span className='text-muted-foreground'>无参数</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <code className='block max-w-72 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>{value}</code>
      </TooltipTrigger>
      <TooltipContent className='max-w-md font-mono text-xs break-all'>{value}</TooltipContent>
    </Tooltip>
  )
}

export function Approvals() {
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const { data, error, isPending, refetch } = useQuery(approvalsQuery(page, SIZE))
  const [pending, setPending] = useState<Decision>(null)
  const [comment, setComment] = useState('')

  const decide = useMutation({
    mutationFn: (d: NonNullable<Decision>) =>
      api(`/admin/api/approvals/${d.approval.id}/decide`, { method: 'POST', body: { decision: d.decision, comment } }),
    onSuccess: (_, d) => {
      toast.success(d.decision === 'approved' ? '已批准，Run 会继续执行' : '已驳回，Run 不会执行这次调用')
      setPending(null)
      void qc.invalidateQueries({ queryKey: ['approvals'] })
    },
    onError: (err) => {
      handleServerError(err)
      if (err instanceof ApiError && err.status === 409) void qc.invalidateQueries({ queryKey: ['approvals'] })
    },
  })

  const open = (approval: Approval, decision: 'approved' | 'rejected') => {
    setComment('')
    setPending({ approval, decision })
  }

  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / SIZE))
  const tool = (a: Approval) => a.tool_name || '工具'

  return (
    <PageShell title='审批中心' description='Agent 调用高风险工具时会暂停，等你批准或驳回。'>
      <div className='overflow-hidden rounded-lg border bg-card'>
        <Table>
          <TableHeader className='bg-muted/40'>
            <TableRow className='hover:bg-transparent'>
              <TableHead className='w-[22%]'>Agent</TableHead>
              <TableHead>工具与参数</TableHead>
              <TableHead>风险</TableHead>
              <TableHead>提交时间</TableHead>
              <TableHead>过期时间</TableHead>
              <TableHead className='w-44'><span className='sr-only'>操作</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {error ? (
              <TableMessage cols={COLS} kind='error' title={error.message} code={(error as ApiError).code} onRetry={() => void refetch()} />
            ) : isPending ? (
              <SkeletonRows cols={COLS} />
            ) : data.items.length === 0 ? (
              <TableMessage cols={COLS} kind='empty' title='没有待审批的调用' hint='Agent 调用高风险工具时会暂停，等你在这里批准或驳回。' />
            ) : (
              data.items.map((a, i) => {
                const created = shortTime(a.created_at)
                const expires = shortTime(a.expires_at)
                return (
                  <MotionRow key={a.id} {...rowMotion(i)} className='h-13'>
                    <TableCell>
                      <div className='font-medium'>{a.agent_name}</div>
                      <div className='font-mono text-xs text-muted-foreground' title={a.run_id}>Run …{a.run_id.slice(-8)}</div>
                    </TableCell>
                    <TableCell>
                      <div className='font-mono text-sm'>{a.tool_name ?? '—'}</div>
                      <ArgsPreview value={a.args_preview} />
                    </TableCell>
                    <TableCell><StatusBadge status={a.risk_level} /></TableCell>
                    <TableCell className='tabular-nums' title={created.title}>{created.text}</TableCell>
                    <TableCell className='tabular-nums' title={expires.title}>{expires.text}</TableCell>
                    <TableCell>
                      <div className='flex items-center justify-end gap-1'>
                        <Button size='sm' variant='outline' onClick={() => open(a, 'approved')}>
                          <Check /> 批准
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant='ghost' size='icon' className='size-8 data-[state=open]:bg-muted' aria-label={`审批 ${a.id.slice(0, 8)} 更多操作`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align='end' className='w-44'>
                            <DropdownMenuItem variant='destructive' onClick={() => open(a, 'rejected')}>
                              <X /> 驳回
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild>
                              <a href='/#runs'><ExternalLink /> 在旧版中查看 Run</a>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </MotionRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {total > SIZE && (
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
        desc={pending?.decision === 'approved' ? '批准后 Run 会立即继续执行这次工具调用，批准后不能撤回。' : '驳回后 Run 不会执行这次工具调用，驳回后不能撤回。'}
        confirmText={pending?.decision === 'approved' ? '确认批准' : '确认驳回'}
        isLoading={decide.isPending}
        handleConfirm={() => pending && decide.mutate(pending)}
      >
        {pending && (
          <div className='grid gap-4'>
            <div className='rounded-md border bg-muted/40 p-3 text-sm'>
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
