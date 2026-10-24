import { describe, expect, it } from 'vitest'
import { SSO_ERROR_FALLBACK, SSO_ERROR_MESSAGES, ssoErrorKind, ssoErrorMessage } from './sso-error'

describe('ssoErrorMessage', () => {
  it('HTP-4003 文案保持不变', () => {
    expect(ssoErrorMessage('HTP-4003')).toBe('单点登录暂不可用：身份提供方的地址被出站策略拦截，请联系管理员。')
  })
  it.each([
    ['access_denied', 'idp_denied', /拒绝/],
    ['SSO-1203', 'state_invalid', /过期/],
    ['invalid_request', 'callback_missing', /参数/],
    ['SSO-1204', 'token_exchange', /凭证/],
  ])('%s → %s', (code, kind, text) => {
    expect(ssoErrorKind(code)).toBe(kind)
    expect(ssoErrorMessage(code)).toMatch(text)
    expect(ssoErrorMessage(code)).not.toBe(SSO_ERROR_FALLBACK)
  })
  it('没有 ssoError 时不显示', () => {
    expect(ssoErrorMessage(undefined)).toBeNull()
    expect(ssoErrorMessage('')).toBeNull()
  })
  it.each(['SSO-9999', 'sso-1203', ' SSO-1203', 'constructor', '__proto__', 'toString', '<img src=x onerror=alert(1)>', 'https://evil.example/', 'x'.repeat(64)])(
    '未知码 %s 一律显示通用文案，不回显原值',
    (code) => {
      expect(ssoErrorKind(code)).toBe('generic')
      expect(ssoErrorMessage(code)).toBe(SSO_ERROR_FALLBACK)
      expect(ssoErrorMessage(code)).not.toContain(code.trim() || '\u0000')
    }
  )
  it('非字符串不显示（路由 validateSearch 已丢弃，这里再兜一次）', () => {
    expect(ssoErrorMessage(1203)).toBeNull()
    expect(ssoErrorMessage(['SSO-1203'])).toBeNull()
  })
  it('所有文案都是固定字符串，不含占位符', () => {
    for (const m of Object.values(SSO_ERROR_MESSAGES)) expect(m).not.toMatch(/[{}$%]/)
  })
})
