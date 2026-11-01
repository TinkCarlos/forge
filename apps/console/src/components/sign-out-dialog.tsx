import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api, ApiError } from '@/lib/api'
import { toast } from 'sonner'
import { onReject } from '@/lib/settle'
import { useAuthStore } from '@/stores/auth-store'
import { ConfirmDialog } from '@/components/confirm-dialog'

interface SignOutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const navigate = useNavigate()
  const reset = useAuthStore((s) => s.reset)
  const [busy, setBusy] = useState(false)

  const handleSignOut = async () => {
    setBusy(true)
    try { await api('/auth/logout', { method: 'POST' }) }
    catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        toast.error('退出登录失败，请重试')
        setBusy(false)
        return
      }
    }
    reset()
    setBusy(false)
    onOpenChange(false)
    navigate({ to: '/sign-in', replace: true }).catch(onReject({ toast: '已退出登录，但跳转登录页失败，请刷新页面' }))
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title='退出登录'
      desc='退出后需要重新登录才能继续管理 Agent。'
      confirmText='退出登录'
      destructive
      isLoading={busy}
      handleConfirm={handleSignOut}
      className='sm:max-w-sm'
    />
  )
}
