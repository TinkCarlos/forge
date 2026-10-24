/**
 * K-31：确认按钮的单次触发闩锁。
 * React 在同一个任务里的多次 click/Enter 之间来不及把按钮重渲染成 disabled，
 * 所以 disabled 挡不住机器速度的连点；这里用同步的标志位挡住第二次及以后的触发。
 * - fire：没锁时执行回调并上锁；
 * - settle(loading)：loading 结束（false）时解锁，允许失败后重试；
 * - 回调没有进入 loading（如表单校验失败）时，下一个任务里自动解锁，按钮不会卡死。
 */
export function createConfirmLatch(isLoading: () => boolean = () => false) {
  let locked = false
  return {
    fire(fn: () => void): boolean {
      if (locked) return false
      locked = true
      fn()
      setTimeout(() => {
        if (!isLoading()) locked = false
      }, 0)
      return true
    },
    settle(loading: boolean) {
      if (!loading) locked = false
    },
    get locked() {
      return locked
    },
  }
}
