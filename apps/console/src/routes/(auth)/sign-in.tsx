import { z } from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { SignIn } from '@/features/auth/sign-in'
import { normalizeSsoError } from '@/features/auth/sign-in/sso-error'

const searchSchema = z.object({
  redirect: z.string().optional(),
  // 白名单码原样保留，其余任何值（超长、带 HTML / 换行、非字符串）收敛成 'unknown'，原值不进路由状态；
  // 页面按码表显示固定文案，'unknown' 显示通用文案
  ssoError: z.unknown().optional().transform(normalizeSsoError).catch('unknown' as const),
})

export const Route = createFileRoute('/(auth)/sign-in')({
  component: SignIn,
  validateSearch: searchSchema,
})
