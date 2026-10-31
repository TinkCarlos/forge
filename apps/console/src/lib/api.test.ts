import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, NETWORK_ERROR_CODE } from './api'
import { getApiAvailability, resetApiAvailability } from './api-availability'

afterEach(() => {
  vi.unstubAllGlobals()
  resetApiAvailability()
})

describe('K-35 api() 断网', () => {
  it('fetch 抛 TypeError（Failed to fetch）时包成中文 ApiError + 固定码 NET-0001，并标记 API 不可用', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const err = await api('/admin/api/agents').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 0, code: 'NET-0001' })
    expect(NETWORK_ERROR_CODE).toBe('NET-0001')
    expect((err as Error).message).toBe('网络连接失败')
    expect((err as Error).message).not.toMatch(/fetch/i)
    expect(getApiAvailability()).toEqual({ status: 'network', code: 'NET-0001' })
  })

  it('请求被 abort 不算断网，原样抛出', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort))
    await expect(api('/admin/api/agents')).rejects.toBe(abort)
    expect(getApiAvailability().status).toBe('ok')
  })

  it('503 标记 API 不可用（FE-N11），其它错误不标记', async () => {
    const res = (status: number) => new Response(JSON.stringify({ error: { code: 'SYS-9002', message: '服务不可用' } }), { status })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(500)))
    await api('/x').catch(() => {})
    expect(getApiAvailability().status).toBe('ok')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(503)))
    await api('/x').catch(() => {})
    expect(getApiAvailability()).toEqual({ status: 'unavailable', code: 'SYS-9002' })
  })
})

describe('NET-0001 读响应体时断网', () => {
  /** 响应头已到，读 body 时连接断开：text() 抛浏览器原文 TypeError。 */
  const brokenBody = (reason: unknown) => ({ status: 200, ok: true, text: () => Promise.reject(reason) }) as unknown as Response

  it.each(['Failed to fetch', 'Load failed'])('text() 抛 TypeError（%s）时包成中文 ApiError + NET-0001，并标记 API 不可用', async (raw) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(brokenBody(new TypeError(raw))))
    const err = await api('/admin/api/approvals').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 0, code: 'NET-0001', message: '网络连接失败' })
    expect((err as Error).message).not.toContain(raw)
    expect(err).not.toBeInstanceOf(TypeError)
    expect(getApiAvailability()).toEqual({ status: 'network', code: 'NET-0001' })
  })

  it('读 body 时被 abort 不算断网，原样抛出', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(brokenBody(abort)))
    await expect(api('/admin/api/approvals')).rejects.toBe(abort)
    expect(getApiAvailability().status).toBe('ok')
  })
})
