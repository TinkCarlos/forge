import { motion } from 'motion/react'
import { AlertTriangle, Inbox, RotateCw } from 'lucide-react'
import { isForbidden } from '@/lib/permissions'
import { Button } from '@/components/ui/button'
import { BackButton } from '@/components/back-button'
import { Skeleton } from '@/components/ui/skeleton'
import { TableCell, TableRow } from '@/components/ui/table'

export function SkeletonRows({ cols, rows = 6 }: { cols: number; rows?: number }) {
  return Array.from({ length: rows }, (_, r) => (
    <TableRow key={r} className='h-13 hover:bg-transparent'>
      {Array.from({ length: cols }, (_, c) => (
        <TableCell key={c}>
          <Skeleton className={c === 0 ? 'h-4 w-40' : 'h-4 w-20'} />
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
