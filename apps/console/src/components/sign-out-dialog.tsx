import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api } from '@/lib/api'
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
    await api('/auth/logout', { method: 'POST' }).catch(() => {})
    reset()
    setBusy(false)
    onOpenChange(false)
    void navigate({ to: '/sign-in', replace: true })
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
