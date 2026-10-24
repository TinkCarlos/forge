import { motion } from 'motion/react'
import { AlertTriangle, Inbox, RotateCw } from 'lucide-react'
import { isForbidden } from '@/lib/permissions'
import { Button } from '@/components/ui/button'
import { BackButton } from '@/components/back-button'
import { Skeleton } from '@/components/ui/skeleton'
import { TableCell, TableRow } from '@/components/ui/table'

/**
 * 骨架行的每一列长什么样。卡片布局（<1024px）下每列变成一行，所以骨架要和真实单元格同高、带同样的 data-label，
 * 否则加载完成时卡片会跳高（UI-065）。高度对照真实内容：title 20+16、badge 24、text 20、switch 18、code 40/36、actions 32+4。
 */
export type SkeletonCol = { kind: 'title' | 'badge' | 'text' | 'switch' | 'code' | 'actions'; label?: string }

function SkeletonCell({ kind }: SkeletonCol) {
  switch (kind) {
    case 'title':
      return (
        <div className='flex flex-col gap-0'>
          <Skeleton className='my-0.5 h-4 w-40' />
          <Skeleton className='my-0.5 h-3 w-24' />
        </div>
      )
    case 'badge':
      return <Skeleton className='h-6 w-16 rounded-full' />
    case 'switch':
      return <Skeleton className='h-[18px] w-8 rounded-full' />
    case 'code':
      return <Skeleton className='h-9 w-44 max-lg:h-10 max-lg:w-40' />
    case 'actions':
      return <Skeleton className='ms-auto h-8 w-16' />
    default:
      return <Skeleton className='my-0.5 h-4 w-20' />
  }
}

export function SkeletonRows({ cols, rows = 6 }: { cols: SkeletonCol[]; rows?: number }) {
  return Array.from({ length: rows }, (_, r) => (
    <TableRow key={r} className='h-13 hover:bg-transparent' aria-hidden='true'>
      {cols.map((col, c) => (
        <TableCell key={c} data-label={col.label} data-actions={col.kind === 'actions' ? '' : undefined}>
          <SkeletonCell {...col} />
        </TableCell>
      ))}
    </TableRow>
  ))
}

export function TableMessage({
  cols,
  kind,
  title,
  hint,
  code,
  action,
  onRetry,
}: {
  cols: number
  kind: 'empty' | 'error'
  title: string
  hint?: string
  code?: string
  action?: React.ReactNode
  onRetry?: () => void
}) {
  const Icon = kind === 'error' ? AlertTriangle : Inbox
  return (
    <TableRow className='hover:bg-transparent'>
      <TableCell colSpan={cols} className='h-64'>
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.25 }}
          className='flex flex-col items-center gap-2 text-center whitespace-normal'
          role={kind === 'error' ? 'alert' : undefined}
        >
          <div className={kind === 'error' ? 'rounded-full bg-destructive/10 p-3 text-destructive' : 'rounded-full bg-muted p-3 text-muted-foreground'}>
            <Icon className='size-5' />
          </div>
          <p className='font-medium'>{title}</p>
          {hint && <p className='max-w-sm text-sm text-muted-foreground'>{hint}</p>}
          {code && <p className='font-mono text-xs text-muted-foreground'>错误码 {code}</p>}
          {onRetry && (
            <Button variant='outline' size='sm' className='mt-2' onClick={onRetry}>
              <RotateCw /> 重试
            </Button>
          )}
          {action}
        </motion.div>
      </TableCell>
    </TableRow>
  )
}

/** 列表加载失败。403 时提示没有权限、只给「返回」（K-29），其他错误给「重试」。 */
export function TableError({ cols, error, onRetry }: { cols: number; error: Error; onRetry: () => void }) {
  const code = (error as { code?: string }).code
  return isForbidden(error) ? (
    <TableMessage cols={cols} kind='error' title='没有权限查看' hint='当前账号的角色没有这项权限。如需开通，请联系管理员。' code={code} action={<BackButton size='sm' className='mt-2' />} />
  ) : (
    <TableMessage cols={cols} kind='error' title={error.message} code={code} onRetry={onRetry} />
  )
}
