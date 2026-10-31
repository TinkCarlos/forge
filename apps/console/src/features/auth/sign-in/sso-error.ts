import { SSO_ERROR_CODES } from '@forge/core/sso-error-codes'

// 单点登录失败时后端 302 到 /next/sign-in?ssoError=<码>（apps/api/src/routes/auth.ts 的 ssoErrorLocation）。
// 白名单 SSO_ERROR_CODES 直接从纯模块 packages/core/src/sso-error-codes.ts 引用（alias @forge/core/sso-error-codes，
// 只指向这一个文件）。码表的键必须和它完全一致（sso-error.test.ts 钉住）；后端只会带白名单里的码，
// 不在白名单的码后端会换成 SYS-9001（SSO_FALLBACK_CODE）。
// 只认码表里的码并映射成固定中文文案；URL 里的原值一律不渲染（未知码 / 非法值 / 非字符串都显示通用文案），
// 显示后用 history.replaceState 把参数从地址栏去掉。

/** 后端白名单里的每个码 → 固定文案。 */
export const SSO_ERROR_CODE_MESSAGES = Object.freeze({
  'HTP-4003': '单点登录暂不可用：身份提供方的地址被出站策略拦截，请联系管理员。',
  'SSO-1201': '单点登录暂不可用：尚未完成配置，或你的账号没有 Forge 访问角色，请联系管理员。',
  'SSO-1202': '暂时无法连接身份提供方，请稍后重试；如果反复出现，请联系管理员。',
  'SSO-1203': '登录状态已过期或无效，请重新发起单点登录。',
  'SSO-1204': '无法向身份提供方验证登录凭证，请重试；如果反复出现，请联系管理员。',
  'SSO-1205': '身份提供方没有返回有效的登录凭证，请重试或联系管理员。',
  'SSO-1206': '登录校验未通过，请重新发起单点登录。',
  'SSO-1207': '身份提供方没有返回访问令牌，请联系管理员检查 SSO 配置。',
  'SSO-1208': '登录凭证中的用户身份不一致，请重新发起单点登录。',
  'SSO-1209': '身份提供方没有返回用户标识，请联系管理员检查 SSO 配置。',
  'SSO-1210': '你的 SSO 账号缺少邮箱，无法创建 Forge 账号，请联系管理员。',
  'SSO-1211': '创建 Forge 账号失败，请稍后重试或联系管理员。',
  // IdP 回调带 error=（如 access_denied）；IdP 的 error / error_description 后端已丢弃，这里也不展示
  'SSO-1212': '身份提供方拒绝了这次登录。如果你需要访问 Forge，请联系管理员开通。',
  // 后端兜底码（意外错误）
  'SYS-9001': '单点登录失败，请稍后重试或联系管理员。',
} as const)

export type SsoErrorCode = keyof typeof SSO_ERROR_CODE_MESSAGES

export const SSO_ERROR_FALLBACK = '单点登录失败，请稍后重试或联系管理员。'

export const SSO_ERROR_PARAM = 'ssoError'

/** 必须同时在导入的白名单和码表里：白名单删掉的码即使码表还留着也按未知码处理（键对不上由测试报错）。 */
function isKnownCode(value: unknown): value is SsoErrorCode {
  return (
    typeof value === 'string' &&
    SSO_ERROR_CODES.has(value) &&
    Object.prototype.hasOwnProperty.call(SSO_ERROR_CODE_MESSAGES, value)
  )
}

/** 路由 validateSearch 用：白名单码原样保留，其余任何值收敛成 'unknown'（原值不进路由状态），缺省 / 空串为 undefined。 */
export function normalizeSsoError(raw: unknown): SsoErrorCode | 'unknown' | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  return isKnownCode(raw) ? raw : 'unknown'
}

/** 没有 ssoError 返回 null；白名单码返回对应文案；其他任何值（含 'unknown'、非字符串）返回通用文案。 */
export function ssoErrorMessage(code: unknown): string | null {
  if (code === undefined || code === null || code === '') return null
  return isKnownCode(code) ? SSO_ERROR_CODE_MESSAGES[code] : SSO_ERROR_FALLBACK
}

/** 去掉登录错误参数，避免复制链接时带上 IdP 原文；保留其他参数与 hash。 */
export function urlWithoutSsoError(href: string): string | null {
  const url = new URL(href)
  const params = [SSO_ERROR_PARAM, 'error', 'error_description', 'error_uri']
  if (!params.some((param) => url.searchParams.has(param))) return null
  for (const param of params) url.searchParams.delete(param)
  return `${url.pathname}${url.search}${url.hash}`
}

interface HistoryWindow {
  location: { href: string }
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void }
}

/** 显示过错误后调用：replaceState 去掉参数（保留 history.state，路由器的 index 不变），不产生新的历史记录。 */
export function clearSsoErrorFromUrl(win: HistoryWindow = window): boolean {
  const next = urlWithoutSsoError(win.location.href)
  if (next === null) return false
  win.history.replaceState(win.history.state, '', next)
  return true
}
