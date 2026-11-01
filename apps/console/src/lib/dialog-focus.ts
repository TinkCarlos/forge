export function restoreDialogFocus(event: Event, opener: HTMLElement | null) {
  event.preventDefault()
  const active = document.activeElement
  // 路由切换或用户已把焦点移到弹层外时，不抢回旧入口。
  if (active && active !== document.body && !active.closest('[role="dialog"], [role="menu"]')) return
  const target = opener?.isConnected ? opener : document.querySelector<HTMLElement>('[data-focus-fallback]')
  target?.focus()
}
