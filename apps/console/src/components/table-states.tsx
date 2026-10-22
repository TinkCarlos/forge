import { motion } from 'motion/react'
import { AlertTriangle, Inbox, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
