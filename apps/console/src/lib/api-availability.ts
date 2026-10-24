/**
 * FE-N11 / UI-074：全局「API 不可用」状态。
 * - api() 遇到断网（fetch 抛 TypeError）或 503 时上报；
 * - 横幅组件轮询 /readyz，200 即恢复。
 * 不依赖 React，便于单测；组件用 useSyncExternalStore 订阅。
 */
export type ApiAvailability =
  | { status: 'ok' }
  | { status: 'network'; code: 'NET-0001' }
  | { status: 'unavailable'; code: string }

export const READYZ_UNAVAILABLE_CODE = 'READYZ-503'

const OK: ApiAvailability = { status: 'ok' }
let state: ApiAvailability = OK
const listeners = new Set<() => void>()

function set(next: ApiAvailability) {
  if (next.status === state.status && ('code' in next ? next.code : '') === ('code' in state ? state.code : '')) return
  state = next
  for (const l of listeners) l()
}

export const getApiAvailability = (): ApiAvailability => state
export function subscribeApiAvailability(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const reportNetworkError = () => set({ status: 'network', code: 'NET-0001' })
export const reportUnavailable = (code = READYZ_UNAVAILABLE_CODE) => set({ status: 'unavailable', code })
export const reportAvailable = () => set(OK)
export const resetApiAvailability = () => {
  state = OK
}

/** 请求 /readyz 并更新状态；返回是否可用。fetchImpl 便于测试注入。 */
export async function checkReady(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl('/readyz', { cache: 'no-store', credentials: 'same-origin' })
    if (res.ok) {
      reportAvailable()
      return true
    }
    reportUnavailable(res.status === 503 ? READYZ_UNAVAILABLE_CODE : `READYZ-${res.status}`)
    return false
  } catch {
    reportNetworkError()
    return false
  }
}
