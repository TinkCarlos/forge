import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { TriangleAlert, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { checkReady, getApiAvailability, subscribeApiAvailability } from '@/lib/api-availability'
import { onReject } from '@/lib/settle'

const POLL_OK_MS = 30_000
const POLL_DOWN_MS = 5_000

/**
 * FE-N11 / UI-074 / K-35：全局「API 不可用」横幅。
 * 断网或 503（含 /readyz 503）时出现，吸顶、在文档流里（手机上把内容往下推而不是盖住），
 * 「立即重试」重新探测 /readyz；恢复后自动消失并重拉失败的查询。
 * 高度写到 --api-banner-h，供吸顶的页头和固定的侧栏让位。
 */
export function ApiUnavailableBanner() {
  const state = useSyncExternalStore(subscribeApiAvailability, getApiAvailability, getApiAvailability)
  const queryClient = useQueryClient()
  const [checking, setChecking] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const down = state.status !== 'ok'

  // 轮询 /readyz：正常时 30s 一次，不可用时 5s 一次；页面不可见时跳过。
  useEffect(() => {
    let timer = 0
    let stopped = false
    const tick = async () => {
      if (document.visibilityState === 'visible') await checkReady()
      if (!stopped) timer = window.setTimeout(() => tick().catch(onReject({ warn: 'readyz poll' })), getApiAvailability().status === 'ok' ? POLL_OK_MS : POLL_DOWN_MS)
    }
    tick().catch(onReject({ warn: 'readyz poll' }))
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [])

  // 从不可用恢复：重拉报错的查询。
  const wasDown = useRef(false)
  useEffect(() => {
    if (wasDown.current && !down) {
      queryClient
        .refetchQueries({ type: 'active', predicate: (q) => q.state.status === 'error' })
        .catch(onReject({ warn: 'refetch after api recovered' }))
    }
    wasDown.current = down
  }, [down, queryClient])

  useLayoutEffect(() => {
    const root = document.documentElement
    const el = ref.current
    if (!el) {
      root.style.setProperty('--api-banner-h', '0px')
      return
    }
    const update = () => root.style.setProperty('--api-banner-h', `${el.offsetHeight}px`)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.setProperty('--api-banner-h', '0px')
    }
  }, [down])

  if (!down) return null

  const message =
    state.status === 'network'
      ? `网络连接失败（${state.code}），请检查网络后重试`
      : `服务暂时不可用（${state.code}），部分数据可能无法加载或保存`

  const retry = () => {
    setChecking(true)
    checkReady()
      .catch(onReject({ warn: 'readyz retry' }))
      .finally(() => setChecking(false))
  }

  return (
    <div
      ref={ref}
      role='alert'
      data-testid='api-unavailable-banner'
      className='sticky top-0 z-[60] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-destructive bg-background px-4 py-2 text-sm text-destructive-text'
    >
      <span className='flex min-w-0 items-start gap-1.5'>
        <TriangleAlert aria-hidden className='mt-0.5 size-4 shrink-0' />
        <span className='min-w-0'>{message}</span>
      </span>
      <Button size='sm' variant='outline' className='h-7 text-foreground' onClick={retry} disabled={checking}>
        {checking && <Loader2 aria-hidden className='size-3.5 animate-spin' />}
        立即重试
      </Button>
    </div>
  )
}
