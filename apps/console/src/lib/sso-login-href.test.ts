import { beforeAll, describe, expect, it } from 'vitest'

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window = { location: { origin: 'https://forge.example' } }
})
const load = () => import('./sso-login-href')

describe('K-18 SSO 入口带上站内 returnTo', () => {
  it.each([
    ['/approvals', '/next/approvals'],
    ['/agents?page=2', '/next/agents?page=2'],
    ['/next/approvals', '/next/approvals'],
    ['/', '/next/'],
  ])('%s → returnTo=%s', async (redirect, returnTo) => {
    const { ssoLoginHref } = await load()
    const href = ssoLoginHref(redirect)
    expect(new URL(href, 'https://forge.example').searchParams.get('returnTo')).toBe(returnTo)
    expect(href.startsWith('/auth/oidc/login?')).toBe(true)
  })
  it('没有 redirect 时不带参数（后端默认 /next/）', async () => {
    const { ssoLoginHref } = await load()
    expect(ssoLoginHref(undefined)).toBe('/auth/oidc/login')
  })
  it.each([
    'https://evil.example/next/approvals',
    '//evil.example/next/',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'http:/next/approvals',
    '/next/..//evil.example',
    '/sign-in',
    '/next/\u0000x',
  ])('外站或不合法的 %s 被拒绝：不带 returnTo，最终落 /next/', async (redirect) => {
    const { ssoLoginHref, isSiteReturnTo } = await load()
    expect(ssoLoginHref(redirect)).toBe('/auth/oidc/login')
    expect(isSiteReturnTo(redirect)).toBe(false)
  })
  it('isSiteReturnTo 只认 /next/ 开头的站内路径', async () => {
    const { isSiteReturnTo } = await load()
    expect(isSiteReturnTo('/next/approvals')).toBe(true)
    expect(isSiteReturnTo('/next')).toBe(false)
    expect(isSiteReturnTo('/admin/api/agents')).toBe(false)
    expect(isSiteReturnTo('/next//evil.example')).toBe(false)
    expect(isSiteReturnTo('/next/\\evil')).toBe(false)
  })
})
