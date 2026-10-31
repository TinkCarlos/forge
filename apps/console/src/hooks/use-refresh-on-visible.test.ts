import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.fn()
const toastAny = vi.fn()
vi.mock('sonner', () => ({ toast: Object.assign((...a: unknown[]) => toastAny(...a), { error: (...a: unknown[]) => toastError(...a) }) }))

const { refreshOnVisible, VISIBLE_REFRESH_MIN_MS } = await import('./use-refresh-on-visible')
const { approvalsQuery } = await import('@/features/approvals/api')

/** 只带 visibilityState 的假 document，用 EventTarget 派发 visibilitychange。 */
function fakeDoc(initial: DocumentVisibilityState = 'visible') {
  const target = new EventTarget()
  const doc = Object.assign(target, { visibilityState: initial }) as EventTarget & { visibilityState: DocumentVisibilityState }
  const set = (v: DocumentVisibilityState) => {
    doc.visibilityState = v
    doc.dispatchEvent(new Event('visibilitychange'))
  }
  return { doc: doc as unknown as Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>, set }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-31T00:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  toastError.mockReset()
  toastAny.mockReset()
})

describe('/next/ 审批列表：切回标签页时刷新一次', () => {
  it('节流窗口是 2 秒', () => {
    expect(VISIBLE_REFRESH_MIN_MS).toBe(2000)
  })

  it('切回 visible 触发一次刷新', () => {
    const { doc, set } = fakeDoc('hidden')
    const refresh = vi.fn().mockResolvedValue(undefined)
    refreshOnVisible(doc, refresh)
    set('visible')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('hidden 不刷新', () => {
    const { doc, set } = fakeDoc('visible')
    const refresh = vi.fn().mockResolvedValue(undefined)
    refreshOnVisible(doc, refresh)
    set('hidden')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('2 秒内连续切换只刷新一次，超过 2 秒再刷新', () => {
    const { doc, set } = fakeDoc('hidden')
    const refresh = vi.fn().mockResolvedValue(undefined)
    refreshOnVisible(doc, refresh)
    set('visible')
    vi.advanceTimersByTime(500)
    set('hidden')
    set('visible')
    vi.advanceTimersByTime(1499)
    set('hidden')
    set('visible')
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    set('hidden')
    set('visible')
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('不加轮询：一直可见时不会自己刷新', () => {
    const { doc, set } = fakeDoc('hidden')
    const refresh = vi.fn().mockResolvedValue(undefined)
    refreshOnVisible(doc, refresh)
    set('visible')
    vi.advanceTimersByTime(60_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('卸载后移除监听，不再刷新', () => {
    const { doc, set } = fakeDoc('hidden')
    const remove = vi.spyOn(doc, 'removeEventListener')
    const refresh = vi.fn().mockResolvedValue(undefined)
    const stop = refreshOnVisible(doc, refresh)
    stop()
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    set('visible')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('刷新失败不弹 toast（错误态沿用列表自己的 TableError），只在控制台留一行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { doc, set } = fakeDoc('hidden')
    const refresh = vi.fn().mockRejectedValue(new Error('网络连接失败'))
    refreshOnVisible(doc, refresh)
    set('visible')
    await vi.runAllTimersAsync()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
    expect(toastAny).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('刷新函数同步抛错也不弹 toast、不冒泡', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { doc, set } = fakeDoc('hidden')
    refreshOnVisible(doc, () => {
      throw new Error('boom')
    })
    expect(() => set('visible')).not.toThrow()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('审批列表页接上了这个 hook；列表 query 关掉 react-query 自带的聚焦刷新，避免生产环境一次切回刷两遍', () => {
    const page = readFileSync(new URL('../features/approvals/index.tsx', import.meta.url), 'utf8')
    expect(page).toMatch(/useRefreshOnVisible\(\s*\(\)\s*=>\s*refetch\(\)\s*\)/)
    expect(page).not.toMatch(/refetchInterval/)
    expect(approvalsQuery(1, 20).refetchOnWindowFocus).toBe(false)
  })
})
