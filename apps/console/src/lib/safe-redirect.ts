// 登录后的跳回地址来自地址栏，谁都能改，所以前端按 S-30 再校验一次：
// 只接受以单个 "/" 开头的站内路径，拒绝 "//"、"/\"、反斜杠和控制字符，
// 解析后 origin 必须是本站。router 记下的是不含 /next 的路径（如 /approvals）；
// 手写的完整地址（/next/approvals）也接受，先去掉前缀。不合法返回 null。
const BASE = '/next'

function isSafePath(p: string): boolean {
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return false
  if (/[\u0000-\u001f\u007f]/.test(p)) return false
  try {
    return new URL(p, window.location.origin).origin === window.location.origin
  } catch {
    return false
  }
}

export function safeRedirectPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null
  if (!isSafePath(raw)) return null
  const hasBase = raw === BASE || raw.startsWith(`${BASE}/`) || raw.startsWith(`${BASE}?`)
  const inner = hasBase ? raw.slice(BASE.length) || '/' : raw
  const path = inner.startsWith('?') ? `/${inner}` : inner
  if (path === '/sign-in' || path.startsWith('/sign-in?')) return null
  return isSafePath(path) ? path : null
}
