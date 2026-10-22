import { z } from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { SignIn } from '@/features/auth/sign-in'

const searchSchema = z.object({
  redirect: z.string().optional(),
  // 非字符串或超长一律丢弃；具体文案在页面里按白名单映射，原值不渲染
  ssoError: z.string().max(64).optional().catch(undefined),
})

export const Route = createFileRoute('/(auth)/sign-in')({
  component: SignIn,
  validateSearch: searchSchema,
})
