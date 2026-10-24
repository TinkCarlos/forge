import { useNavigate, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { backTarget } from '@/lib/permissions'
import { Button } from '@/components/ui/button'

/** 403 用：有站内历史回上一页，直接打开的地址（没有历史）回 /agents。 */
export function BackButton({ size, className }: { size?: 'sm' | 'default'; className?: string }) {
  const { history } = useRouter()
  const navigate = useNavigate()
  const onClick = () => {
    const target = backTarget(history.canGoBack())
    if (target === 'history') history.back()
    else void navigate({ to: target, replace: true })
  }
  return (
    <Button variant='outline' size={size} className={className} onClick={onClick}>
      <ArrowLeft /> 返回
    </Button>
  )
}
