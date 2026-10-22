// 单点登录失败时后端 302 到 /next/sign-in?ssoError=<code>。
// 只认白名单里的错误码并映射成固定文案；原值一律不渲染，防止借参数注入或伪造提示。
const SSO_ERROR_MESSAGES: Record<string, string> = {
  'HTP-4003': '单点登录暂不可用：身份提供方的地址被出站策略拦截，请联系管理员。',
}

export const SSO_ERROR_FALLBACK = '单点登录失败，请稍后重试或联系管理员。'

export function ssoErrorMessage(code: unknown): string | null {
  if (typeof code !== 'string' || code.length === 0) return null
  return Object.prototype.hasOwnProperty.call(SSO_ERROR_MESSAGES, code) ? SSO_ERROR_MESSAGES[code] : SSO_ERROR_FALLBACK
}
