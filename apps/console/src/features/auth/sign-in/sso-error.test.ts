import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SSO_ERROR_CODE_MESSAGES,
  SSO_ERROR_FALLBACK,
  clearSsoErrorFromUrl,
  normalizeSsoError,
  ssoErrorMessage,
  urlWithoutSsoError,
} from './sso-error'

// 后端白名单：apps/api/src/routes/auth.ts 的 SSO_ERROR_CODES。
// 不能直接 import：auth.ts 在模块顶层就解析运行时配置（@forge/core config，缺 DATABASE_URL 等直接抛
// "Invalid configuration"），还会拉进 fastify / @forge/store。所以这里读源码文本解析 Set 字面量，
// 标识符（如 OUTBOUND_BLOCKED_CODE）到 packages/core/src 里解析成字面值；解析不出来就失败，不 skip。
const APPS = new URL('../../../../../', import.meta.url)
const CORE_SRC = new URL('../packages/core/src/', APPS)
function backendSsoErrorCodes(): string[] {
  const src = readFileSync(new URL('api/src/routes/auth.ts', APPS), 'utf8')
  const m = src.match(/export const SSO_ERROR_CODES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/)
  if (!m) throw new Error('auth.ts 里找不到 SSO_ERROR_CODES = new Set([...])')
  const core = readdirSync(CORE_SRC).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(new URL(f, CORE_SRC), 'utf8')).join('\n')
  return m[1]
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const lit = t.match(/^"([^"]+)"$/)
      if (lit) return lit[1]
      const def = core.match(new RegExp(`export const ${t}\\s*=\\s*"([^"]+)"`))
      if (!def) throw new Error(`无法解析标识符 ${t}`)
      return def[1]
    })
}

describe('码表与后端白名单一致', () => {
  it('前端码表的键 == 后端 SSO_ERROR_CODES', () => {
    const backend = backendSsoErrorCodes()
    expect(backend).toContain('SSO-1212')
    expect(backend.length).toBeGreaterThanOrEqual(14)
    expect(Object.keys(SSO_ERROR_CODE_MESSAGES).sort()).toEqual([...backend].sort())
  })
})

describe('ssoErrorMessage', () => {
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
