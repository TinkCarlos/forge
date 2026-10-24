import { safeRedirectPath } from './safe-redirect'

// K-18：从 SSO 入口登录后回到原页面。登录前把站内路径作为 returnTo 传给 /auth/oidc/login。
// 前端先校验一次（只放行 /next/ 开头的站内路径，拒绝 //、/\、反斜杠、协议写法、.. 段、控制字符，
// 包括 URL 编码后的这些写法）；后端 safeReturnTo 照样兜底。不合法就不带参数，后端默认落 /next/。
const LOGIN = '/auth/oidc/login'

function hasBadParts(p: string): boolean {
  return p.includes('\\') || p.includes('//') || /[\u0000-\u001f\u007f]/.test(p) || /(^|\/)\.\.?(\/|$|\?|#)/.test(p)
}

export function isSiteReturnTo(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/next/') || value.length > 2048) return false
  if (hasBadParts(value)) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return false
  }
  return !hasBadParts(decoded)
}

/** redirect 是 router 记下的站内路径（不含 /next）；手写的 /next/... 也接受。 */
export function ssoLoginHref(redirect: unknown): string {
  if (redirect === undefined) return LOGIN
  const inner = safeRedirectPath(redirect)
  if (!inner) return LOGIN
  const returnTo = `/next${inner.startsWith('/') ? inner : `/${inner}`}`
  return isSiteReturnTo(returnTo) ? `${LOGIN}?${new URLSearchParams({ returnTo }).toString()}` : LOGIN
}
