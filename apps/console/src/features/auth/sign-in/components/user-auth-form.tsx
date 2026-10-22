import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, LogIn } from 'lucide-react'
import { api, ApiError, type Session } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/password-input'

type AuthConfig = { localLogin?: boolean; oidcConfigured?: boolean }

export function UserAuthForm({ className, redirectTo }: { className?: string; redirectTo?: string }) {
  const navigate = useNavigate()
  const setSession = useAuthStore((s) => s.setSession)
  const [config, setConfig] = useState<AuthConfig>({ localLogin: true })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<AuthConfig>('/auth/config').then(setConfig).catch(() => {})
  }, [])

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setSession(await api<Session>('/auth/local/login', { method: 'POST', body: { email, password } }))
      // redirect 是 router 记下的完整 href（含 /next 前缀），用 history 跳回
      if (redirectTo) await navigate({ href: redirectTo.replace(/^\/next/, '') || '/', replace: true })
      else await navigate({ to: '/agents', replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('登录失败，请稍后再试', 0))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className={cn('grid gap-4', className)}>
      {config.localLogin !== false ? (
        <>
          <div className='grid gap-1.5'>
            <Label htmlFor='email'>邮箱</Label>
            <Input id='email' type='email' required autoComplete='username' placeholder='name@company.com' value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='password'>密码</Label>
            <PasswordInput id='password' required autoComplete='current-password' value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <AnimatePresence initial={false}>
            {error && (
              <motion.p
                key='err'
                role='alert'
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto', x: [0, -6, 6, -3, 3, 0] }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3 }}
                className='text-sm text-destructive'
              >
                {error.message}
                {error.code ? `（${error.code}）` : ''}
              </motion.p>
            )}
          </AnimatePresence>
          <Button type='submit' className='mt-2' disabled={busy}>
            {busy ? <Loader2 className='animate-spin' /> : <LogIn />}
            登录
          </Button>
        </>
      ) : (
        <p className='text-sm text-muted-foreground'>请使用统一 SSO 登录。</p>
      )}
      {config.oidcConfigured && (
        <Button variant='outline' asChild>
          <a href='/auth/oidc/login'>使用统一 SSO 登录</a>
        </Button>
      )}
    </form>
  )
}
