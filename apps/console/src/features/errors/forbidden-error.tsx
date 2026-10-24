import { ShieldX } from 'lucide-react'
import { BackButton } from '@/components/back-button'

/** 403：路由守卫拦下、或接口返回 403 时显示。只有「返回」，重试没有意义。 */
export function ForbiddenError() {
  return (
    <div className='flex min-h-[60svh] w-full flex-col items-center justify-center gap-2 px-4 text-center' role='alert'>
      <div className='mb-2 rounded-full bg-muted p-3 text-muted-foreground'>
        <ShieldX className='size-6' aria-hidden='true' />
      </div>
      <h1 className='text-2xl font-semibold tabular-nums'>403</h1>
      <span className='font-medium'>没有权限访问这个页面</span>
      <p className='max-w-sm text-sm text-muted-foreground'>当前账号的角色没有这项权限。如需开通，请联系管理员。</p>
      <BackButton className='mt-4' />
    </div>
  )
}
