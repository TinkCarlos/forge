import { describe, expect, it, vi } from 'vitest'
import { createConfirmLatch } from './confirm-latch'

describe('K-31 确认按钮单次触发', () => {
  it('同一轮里连点多次只触发一次', () => {
    const fn = vi.fn()
    const latch = createConfirmLatch()
    latch.fire(fn)
    latch.fire(fn)
    latch.fire(fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('处理结束（loading 由 true 变 false）后可以再次确认，比如失败后重试', () => {
    const fn = vi.fn()
    const latch = createConfirmLatch()
    latch.fire(fn)
    latch.settle(true)
    latch.fire(fn)
    expect(fn).toHaveBeenCalledTimes(1)
    latch.settle(false)
    latch.fire(fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('回调没有进入 loading（例如表单校验失败）时，下一个任务里自动解锁', async () => {
    const fn = vi.fn()
    let loading = false
    const latch = createConfirmLatch(() => loading)
    latch.fire(fn)
    latch.fire(fn)
    await new Promise((r) => setTimeout(r, 0))
    latch.fire(fn)
    expect(fn).toHaveBeenCalledTimes(2)
    loading = true
    await new Promise((r) => setTimeout(r, 0))
    latch.fire(fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
