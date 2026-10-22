import { useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  disabled?: boolean
  desc: React.JSX.Element | string
  cancelBtnText?: string
  confirmText?: React.ReactNode
  destructive?: boolean
  isLoading?: boolean
  className?: string
  children?: React.ReactNode
} & (
  | { form: string; handleConfirm?: undefined }
  | { form?: undefined; handleConfirm: () => void }
)

export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    title,
    desc,
    children,
    className,
    confirmText,
    cancelBtnText,
    destructive,
    isLoading,
    disabled = false,
    form,
    handleConfirm,
    ...actions
  } = props
  const returnTo = useReturnFocus(actions.open)
  return (
    <AlertDialog {...actions}>
      <AlertDialogContent
        className={cn(className && className)}
        onCloseAutoFocus={(e) => {
          const el = returnTo.current
          returnTo.current = null
          const target = el?.isConnected ? el : document.querySelector<HTMLElement>('[data-focus-fallback]')
          if (!target) return
          e.preventDefault()
          target.focus()
        }}
      >
        <AlertDialogHeader className='text-start'>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{desc}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>
            {cancelBtnText ?? '取消'}
          </AlertDialogCancel>
          <Button
            type={form ? 'submit' : 'button'}
            form={form}
            onClick={handleConfirm}
            variant={destructive ? 'destructive' : 'default'}
            disabled={disabled || isLoading}
            aria-busy={isLoading}
          >
            {confirmText ?? '确认'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * 打开时记下触发元素，关闭后把焦点还回去。
 * 从下拉菜单项打开时，菜单项会随菜单卸载，所以改记菜单的 ⋯ 触发按钮。
 * 触发元素已不在页面上（比如审批行被处理掉）时，退回页面标题 [data-focus-fallback]。
 */
function useReturnFocus(open: boolean) {
  const ref = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const active = document.activeElement as HTMLElement | null
    const menu = active?.closest<HTMLElement>('[role="menu"]')
    const trigger = menu?.id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`) : null
    ref.current = trigger ?? (active && active !== document.body ? active : null)
  }, [open])
  return ref
}
