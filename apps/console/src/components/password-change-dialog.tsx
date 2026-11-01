import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api, ApiError, type Session } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { restoreDialogFocus } from '@/lib/dialog-focus'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/password-input'

export function PasswordChangeDialog({ onClose, returnFocusTo }: { onClose: () => void; returnFocusTo: React.RefObject<HTMLElement | null> }) {
  const navigate = useNavigate()
  const reset = useAuthStore(s => s.reset)
  const [revision, setRevision] = useState<number | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const currentInput = useRef<HTMLInputElement>(null)
  const newInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let active = true
    api<Session>('/auth/session').then(session => {
      if (!active) return
      if (session.user?.revision) setRevision(session.user.revision)
      else setError({ message: '无法读取账号版本，请关闭后重试' })
    }).catch(() => { if (active) setError({ message: '无法读取账号，请关闭后重试' }) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (error?.field === 'currentPassword') currentInput.current?.focus()
    if (error?.field === 'newPassword') newInput.current?.focus()
  }, [error])
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !revision) return
    setBusy(true)
    setError(null)
    try {
      await api('/auth/password', { method: 'POST', headers: { 'If-Match': `"${revision}"` }, body: { currentPassword, newPassword } })
      reset()
      onClose()
      await navigate({ to: '/sign-in', replace: true })
    } catch (err) {
      const field = err instanceof ApiError ? err.details?.field : undefined
      setError({ message: err instanceof Error ? err.message : '修改密码失败', field })
    }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent onCloseAutoFocus={event => restoreDialogFocus(event, returnFocusTo.current)}>
      <DialogHeader><DialogTitle>修改密码</DialogTitle><DialogDescription>修改密码后需要重新登录。</DialogDescription></DialogHeader>
      <form onSubmit={submit} className='grid gap-4'>
        <div className='grid gap-1.5'><Label htmlFor='current-password'>当前密码</Label><PasswordInput ref={currentInput} id='current-password' required disabled={busy} aria-invalid={error?.field === 'currentPassword'} aria-describedby={error?.field === 'currentPassword' ? 'password-error' : undefined} maxLength={256} autoComplete='current-password' value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></div>
        <div className='grid gap-1.5'><Label htmlFor='new-password'>新密码</Label><PasswordInput ref={newInput} id='new-password' required disabled={busy} aria-invalid={error?.field === 'newPassword'} aria-describedby={error?.field === 'newPassword' ? 'new-password-hint password-error' : 'new-password-hint'} minLength={8} maxLength={256} autoComplete='new-password' value={newPassword} onChange={e => setNewPassword(e.target.value)} /><p id='new-password-hint' className='text-xs text-muted-foreground'>使用 8–256 个字符。</p></div>
        {error && <p id='password-error' role='alert' className='text-sm text-destructive-text'>{error.message}</p>}
        <DialogFooter><Button type='button' variant='outline' disabled={busy} onClick={onClose}>取消</Button><Button type='submit' disabled={busy || revision === null}>{busy ? '保存中…' : '修改密码'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
