import { motion } from 'motion/react'
import { useSearch } from '@tanstack/react-router'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { UserAuthForm } from './components/user-auth-form'

export function SignIn() {
  const { redirect } = useSearch({ from: '/(auth)/sign-in' })

  return (
    <AuthLayout>
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: 'easeOut' }}>
        <Card className='gap-4'>
          <CardHeader>
            <CardTitle className='text-lg tracking-tight'>登录 Forge 控制台</CardTitle>
            <CardDescription>用管理员账号登录，管理 Agent、审批和开放 API。</CardDescription>
          </CardHeader>
          <CardContent>
            <UserAuthForm redirectTo={redirect} />
          </CardContent>
        </Card>
      </motion.div>
    </AuthLayout>
  )
}
