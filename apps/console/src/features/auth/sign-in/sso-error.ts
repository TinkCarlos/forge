// 单点登录失败时后端 302 到 /next/sign-in?ssoError=<code>。
// 只认白名单里的错误码并映射成固定文案；原值一律不渲染，防止借参数注入或伪造提示。
//
// 码表（前端已就绪；除 HTP-4003 外，目前后端回调出错还是直接返回 400/401 JSON，需要后端改成 302 带 ssoError）：
//   HTP-4003         出站策略拦截了 IdP 地址（后端已在 /auth/oidc/login 映射）
//   access_denied    IdP 拒绝登录：IdP 回调带 error=access_denied（OAuth 标准值，后端按白名单原样转发）
//   SSO-1203         登录状态过期或不匹配（后端 identity 里 state 校验失败的现有码）
//   invalid_request  回调参数缺失：后端现在也用 SSO-1203，建议拆开后转发为这个值（OAuth 标准值）
//   SSO-1204         令牌交换失败（后端现有码）
//   其他任何值        通用文案

export type SsoErrorKind = 'outbound_blocked' | 'idp_denied' | 'state_invalid' | 'callback_missing' | 'token_exchange' | 'generic'

export const SSO_ERROR_FALLBACK = '单点登录失败，请稍后重试或联系管理员。'

export const SSO_ERROR_MESSAGES: Record<SsoErrorKind, string> = {
  outbound_blocked: '单点登录暂不可用：身份提供方的地址被出站策略拦截，请联系管理员。',
  idp_denied: '身份提供方拒绝了这次登录。如果你需要访问 Forge，请联系管理员开通。',
  state_invalid: '登录状态已过期或无效，请重新发起单点登录。',
  callback_missing: '单点登录回调缺少必要参数，请重新发起单点登录。',
  token_exchange: '无法向身份提供方验证登录凭证，请重试；如果反复出现，请联系管理员。',
  generic: SSO_ERROR_FALLBACK,
}

const CODE_TO_KIND: Readonly<Record<string, SsoErrorKind>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, SsoErrorKind>, {
    'HTP-4003': 'outbound_blocked',
    access_denied: 'idp_denied',
    'SSO-1203': 'state_invalid',
    invalid_request: 'callback_missing',
    'SSO-1204': 'token_exchange',
  })
)

/** 未知码（含大小写不符、带空格、原型链上的名字）一律 generic。 */
export function ssoErrorKind(code: string): SsoErrorKind {
  return Object.prototype.hasOwnProperty.call(CODE_TO_KIND, code) ? CODE_TO_KIND[code] : 'generic'
}

export function ssoErrorMessage(code: unknown): string | null {
  if (typeof code !== 'string' || code.length === 0) return null
  return SSO_ERROR_MESSAGES[ssoErrorKind(code)]
}
