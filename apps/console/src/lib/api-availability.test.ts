import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkReady,
  getApiAvailability,
  reportNetworkError,
  reportUnavailable,
  resetApiAvailability,
  subscribeApiAvailability,
} from './api-availability'

afterEach(() => resetApiAvailability())

describe('FE-N11 API 可用性', () => {
  it('上报断网/503 会通知订阅者，状态相同不重复通知', () => {
    const fn = vi.fn()
    const off = subscribeApiAvailability(fn)
    reportNetworkError()
    reportNetworkError()
    expect(fn).toHaveBeenCalledTimes(1)
    reportUnavailable('READYZ-503')
    expect(getApiAvailability()).toEqual({ status: 'unavailable', code: 'READYZ-503' })
    expect(fn).toHaveBeenCalledTimes(2)
    off()
  })

  it('checkReady：/readyz 200 恢复，503 不可用，fetch 抛错算断网', async () => {
    reportNetworkError()
    expect(await checkReady(vi.fn().mockResolvedValue(new Response('{"status":"ready"}', { status: 200 })))).toBe(true)
    expect(getApiAvailability().status).toBe('ok')
    expect(await checkReady(vi.fn().mockResolvedValue(new Response('{"database":false}', { status: 503 })))).toBe(false)
    expect(getApiAvailability()).toEqual({ status: 'unavailable', code: 'READYZ-503' })
    expect(await checkReady(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))).toBe(false)
    expect(getApiAvailability()).toEqual({ status: 'network', code: 'NET-0001' })
  })

  it('checkReady 请求的是 /readyz，且不带缓存', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await checkReady(f)
    expect(f).toHaveBeenCalledWith('/readyz', expect.objectContaining({ cache: 'no-store' }))
  })
})
