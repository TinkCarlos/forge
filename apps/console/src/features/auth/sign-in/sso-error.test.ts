import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SSO_ERROR_CODES, SSO_FALLBACK_CODE } from '@forge/core/sso-error-codes'
import {
  SSO_ERROR_CODE_MESSAGES,
  SSO_ERROR_FALLBACK,
  clearSsoErrorFromUrl,
  normalizeSsoError,
  ssoErrorMessage,
  urlWithoutSsoError,
} from './sso-error'

// 后端白名单在纯模块 packages/core/src/sso-error-codes.ts（无任何 import），控制台经 alias
// @forge/core/sso-error-codes 直接引用（只指向这一个文件，不暴露 @forge/core 根）。
describe('码表与后端白名单一致', () => {
  it('前端码表的键 == 导入的 SSO_ERROR_CODES（完全一致，不多不少）', () => {
    expect(SSO_ERROR_CODES.has('SSO-1212')).toBe(true)
    expect(SSO_ERROR_CODES.has(SSO_FALLBACK_CODE)).toBe(true)
    expect(SSO_ERROR_CODES.size).toBeGreaterThanOrEqual(14)
    expect(Object.keys(SSO_ERROR_CODE_MESSAGES).sort()).toEqual([...SSO_ERROR_CODES].sort())
  })
  it('sso-error.ts 从 @forge/core/sso-error-codes 引用白名单，不再自己抄', () => {
    const src = readFileSync(new URL('./sso-error.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/from '@forge\/core\/sso-error-codes'/)
    expect(src).not.toMatch(/from '@forge\/core'/)
  })
  it('后端兜底码 SSO_FALLBACK_CODE 的文案就是通用文案', () => {
    expect(ssoErrorMessage(SSO_FALLBACK_CODE)).toBe(SSO_ERROR_FALLBACK)
  })
})

describe('ssoErrorMessage', () => {
  it('SSO-1201 同时说明未配置与缺少访问角色，不假定允许本地登录', () => {
    expect(ssoErrorMessage('SSO-1201')).toBe('单点登录暂不可用：尚未完成配置，或你的账号没有 Forge 访问角色，请联系管理员。')
  })
  it('SSO-1212（IdP 回调带 error=）显示固定中文文案', () => {
    expect(ssoErrorMessage('SSO-1212')).toBe('身份提供方拒绝了这次登录。如果你需要访问 Forge，请联系管理员开通。')
  })
  it('HTP-4003 文案保持不变', () => {
    expect(ssoErrorMessage('HTP-4003')).toBe('单点登录暂不可用：身份提供方的地址被出站策略拦截，请联系管理员。')
  })
  it('白名单里每个码都有中文文案；除 SYS-9001 外都不是通用文案', () => {
    for (const [code, text] of Object.entries(SSO_ERROR_CODE_MESSAGES)) {
      expect(ssoErrorMessage(code)).toBe(text)
      expect(text).toMatch(/[\u4e00-\u9fff]/)
      if (code !== 'SYS-9001') expect(text).not.toBe(SSO_ERROR_FALLBACK)
    }
  })
  it('通用文案以「单点登录失败」开头', () => {
    expect(SSO_ERROR_FALLBACK.startsWith('单点登录失败')).toBe(true)
  })
  it('没有 ssoError 时不显示', () => {
    expect(ssoErrorMessage(undefined)).toBeNull()
    expect(ssoErrorMessage(null)).toBeNull()
    expect(ssoErrorMessage('')).toBeNull()
  })
  it.each([
    'SSO-9999', 'sso-1212', ' SSO-1212', 'SSO-1212 ', 'SSO-1212\n', 'access_denied', 'invalid_request',
    'constructor', '__proto__', 'toString', 'hasOwnProperty',
    '<img src=x onerror=alert(1)>', '<b>SSO-1212</b>', 'SSO-1212\r\n<script>alert(1)</script>', '第一行\n第二行',
    'https://evil.example/', 'x'.repeat(65), 'x'.repeat(5000),
  ])('未知码 / 非法值 %j 一律显示通用文案，不回显原值', (code) => {
    expect(ssoErrorMessage(code)).toBe(SSO_ERROR_FALLBACK)
    for (const piece of code.split(/\s+/).filter((p) => p.length > 2)) expect(SSO_ERROR_FALLBACK).not.toContain(piece)
  })
  it.each([1212, ['SSO-1212'], { a: 1 }, true])('非字符串 %j 显示通用文案', (code) => {
    expect(ssoErrorMessage(code)).toBe(SSO_ERROR_FALLBACK)
  })
  it('所有文案都是固定字符串，不含占位符和 HTML', () => {
    for (const m of [...Object.values(SSO_ERROR_CODE_MESSAGES), SSO_ERROR_FALLBACK]) expect(m).not.toMatch(/[{}$%<>]/)
  })
})

describe('normalizeSsoError（路由 validateSearch 用）', () => {
  it('白名单码原样保留，其余收敛成 unknown，缺省为 undefined', () => {
    expect(normalizeSsoError('SSO-1212')).toBe('SSO-1212')
    expect(normalizeSsoError('<script>')).toBe('unknown')
    expect(normalizeSsoError(1212)).toBe('unknown')
    expect(normalizeSsoError('x'.repeat(5000))).toBe('unknown')
    expect(normalizeSsoError(undefined)).toBeUndefined()
    expect(normalizeSsoError('')).toBeUndefined()
  })
})

describe('显示后从 URL 去掉 ssoError', () => {
  it('清除所有 IdP 错误原文参数，保留 redirect、其他参数和 hash', () => {
    expect(urlWithoutSsoError('https://forge.example/next/sign-in?ssoError=SSO-1212&error=access_denied&error_description=private&error_uri=https%3A%2F%2Fidp.example&redirect=%2Fnext%2Fagents&x=1#tab')).toBe(
      '/next/sign-in?redirect=%2Fnext%2Fagents&x=1#tab'
    )
    expect(urlWithoutSsoError('https://forge.example/next/sign-in?error_description=private')).toBe('/next/sign-in')
  })
  it('只去掉 ssoError，保留 redirect 和 hash', () => {
    expect(urlWithoutSsoError('https://forge.example/next/sign-in?ssoError=SSO-1212&redirect=%2Fnext%2Fagents#x')).toBe(
      '/next/sign-in?redirect=%2Fnext%2Fagents#x'
    )
    expect(urlWithoutSsoError('https://forge.example/next/sign-in?ssoError=%3Cimg%3E')).toBe('/next/sign-in')
  })
  it('没有 ssoError 时返回 null（不调 replaceState）', () => {
    expect(urlWithoutSsoError('https://forge.example/next/sign-in?redirect=%2Fnext%2F')).toBeNull()
  })
  it('clearSsoErrorFromUrl 调 history.replaceState，保留 history.state', () => {
    const calls: unknown[][] = []
    const state = { __TSR_index: 3 }
    const win = {
      location: { href: 'https://forge.example/next/sign-in?redirect=%2Fnext%2F&ssoError=SSO-1212' },
      history: { state, replaceState: (...args: unknown[]) => calls.push(args) },
    }
    expect(clearSsoErrorFromUrl(win)).toBe(true)
    expect(calls).toEqual([[state, '', '/next/sign-in?redirect=%2Fnext%2F']])
    expect(String(calls[0][2])).not.toContain('ssoError')
  })
  it('clearSsoErrorFromUrl 没有参数时不动 history', () => {
    const calls: unknown[][] = []
    const win = { location: { href: 'https://forge.example/next/sign-in' }, history: { state: null, replaceState: (...a: unknown[]) => calls.push(a) } }
    expect(clearSsoErrorFromUrl(win)).toBe(false)
    expect(calls).toEqual([])
  })
})
