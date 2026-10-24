import { afterEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

const { onReject } = await import('./settle')

afterEach(() => {
  vi.restoreAllMocks()
  toastError.mockReset()
})

describe('onReject', () => {
  it('warn：一行字符串，不带堆栈和换行，不弹 toast', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = new Error('network\ndown')
    await Promise.reject(err).catch(onReject({ warn: 'agents.invalidate' }))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toEqual(['[forge] agents.invalidate: network down'])
    expect(toastError).not.toHaveBeenCalled()
  })
  it('warn：非 Error 的拒绝值也转成字符串', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await Promise.reject({ code: 1 }).catch(onReject({ warn: 'x' }))
    expect(typeof warn.mock.calls[0][0]).toBe('string')
    expect(warn.mock.calls[0]).toHaveLength(1)
  })
  it('toast：给用户固定文案，不回显错误原文', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await Promise.reject(new Error('secret detail')).catch(onReject({ toast: '重试失败，请稍后再试' }))
    expect(toastError).toHaveBeenCalledWith('重试失败，请稍后再试')
    expect(JSON.stringify(toastError.mock.calls)).not.toContain('secret detail')
    expect(warn).not.toHaveBeenCalled()
  })
  it('handler 自身不抛', () => {
    expect(() => onReject({ warn: 'x' })(undefined)).not.toThrow()
  })
})
