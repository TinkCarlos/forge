import { motion } from 'motion/react'
import { useSearch } from '@tanstack/react-router'
import { CircleAlert } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { UserAuthForm } from './components/user-auth-form'
import { ssoErrorMessage } from './sso-error'

export function SignIn() {
  const { redirect, ssoError } = useSearch({ from: '/(auth)/sign-in' })
  const ssoMessage = ssoErrorMessage(ssoError)

  return (
    <AuthLayout>
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: 'easeOut' }}>
        <Card className='gap-4'>
          <CardHeader>
            <CardTitle className='text-lg tracking-tight'>登录 Forge 控制台</CardTitle>
            <CardDescription>用管理员账号登录，管理 Agent、审批和开放 API。</CardDescription>
          </CardHeader>
          <CardContent className='grid gap-4'>
            {ssoMessage && (
              <Alert variant='destructive' role='alert'>
                <CircleAlert aria-hidden='true' />
                <AlertDescription>{ssoMessage}</AlertDescription>
              </Alert>
            )}
            <UserAuthForm redirectTo={redirect} />
          </CardContent>
        </Card>
      </motion.div>
    </AuthLayout>
  )
}
