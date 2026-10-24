import { useEffect, useRef } from 'react'

/**
 * FE-N03：手机侧栏抽屉不是由 DialogTrigger 打开的，Radix 关闭后焦点会掉到 body。
 * 打开时记下当时的焦点元素，关闭后如果焦点在 body（Esc、点遮罩），把它还给触发按钮。
 * 关闭时焦点已经去了别处（比如点了抽屉里的链接）就不动。
 */
export function useReturnFocus(open: boolean, fallbackSelector: string) {
  const opener = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open && !wasOpen.current) {
      const a = document.activeElement
      opener.current = a instanceof HTMLElement && a !== document.body ? a : null
    }
    if (!open && wasOpen.current) {
      const target = opener.current
      // 抽屉有退场动画，Radix 卸载 FocusScope 时才把焦点放到 body；在退场期间（最多 1s）每 50ms 看一次。
      const started = Date.now()
      const id = window.setInterval(() => {
        const a = document.activeElement
        const settled = !document.querySelector('[data-slot=sheet-content]')
        if (a && a !== document.body) {
          if (settled) window.clearInterval(id)
        } else if (settled) {
          const el = target?.isConnected ? target : document.querySelector<HTMLElement>(fallbackSelector)
          el?.focus()
          window.clearInterval(id)
        }
        if (Date.now() - started > 1000) window.clearInterval(id)
      }, 50)
      wasOpen.current = open
      return () => window.clearInterval(id)
    }
    wasOpen.current = open
  }, [open, fallbackSelector])
}
