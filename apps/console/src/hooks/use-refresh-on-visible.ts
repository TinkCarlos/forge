import { useEffect, useRef } from 'react'
import { onReject } from '@/lib/settle'

/** 切回标签页后，这么久之内不重复刷新。 */
export const VISIBLE_REFRESH_MIN_MS = 2000

type VisibilityDoc = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>

/**
 * 页面从后台切回可见时刷新一次（没有实时推送时的临时方案，不轮询）。
 * - 只在 visibilityState 变成 visible 时触发，hidden 不刷新；
 * - 距离上次触发不到 2 秒不重复刷新；
 * - 刷新失败不弹 toast：列表自己的错误态会显示，这里只在控制台留一行。
 * 返回值用来移除监听。
 */
export function refreshOnVisible(doc: VisibilityDoc, refresh: () => Promise<unknown>): () => void {
  let last = Number.NEGATIVE_INFINITY
  let active = true
  const onChange = () => {
    if (!active || doc.visibilityState !== 'visible') return
    const now = Date.now()
    if (now - last < VISIBLE_REFRESH_MIN_MS) return
    last = now
    new Promise((resolve) => resolve(refresh())).catch(onReject({ warn: 'refresh on visible' }))
  }
  doc.addEventListener('visibilitychange', onChange)
  return () => {
    active = false
    doc.removeEventListener('visibilitychange', onChange)
  }
}

/** 组件版：挂载时监听 document 的 visibilitychange，卸载时移除。refresh 总是用最新的那个。 */
export function useRefreshOnVisible(refresh: () => Promise<unknown>) {
  const latest = useRef(refresh)
  useEffect(() => {
    latest.current = refresh
  })
  useEffect(() => refreshOnVisible(document, () => latest.current()), [])
}
