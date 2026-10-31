import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')

/** 取出 app.js 里的顶层函数源码（从 `function name(` 到行首的 `}`）。 */
function fnSource(name: string) {
  const m = APP.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!m) throw new Error(`app.js 里没有 function ${name}`)
  return m[0]
}

function load<T>(names: string[], ret: string, scope: Record<string, unknown> = {}): T {
  const keys = Object.keys(scope)
  return new Function(...keys, `${names.map(fnSource).join('\n')}\nreturn ${ret}`)(...keys.map((k) => scope[k])) as T
}

describe('K-36 旧版错误提示带错误码', () => {
  it('errorText：有 code 时附上「错误码 XXX」，没有时只显示原文', () => {
    const errorText = load<(e: unknown) => string>(['errorText'], 'errorText')
    expect(errorText(Object.assign(new Error('不支持 env: 引用'), { code: 'CFG-8504' }))).toBe('不支持 env: 引用（错误码 CFG-8504）')
    expect(errorText(new Error('请求失败 (500)'))).toBe('请求失败 (500)')
    expect(errorText('文本')).toBe('文本')
  })

  it('所有错误 toast 和加载失败卡片都经过 errorText，不再直接用 error.message', () => {
    expect(APP).not.toMatch(/toast\(\s*error\.message/)
    expect(fnSource('errorCard')).toMatch(/errorText\(error\)/)
    expect((APP.match(/toast\(errorText\(error\), "error"\)/g) ?? []).length).toBeGreaterThanOrEqual(17)
  })

  it('断网时 api() 抛中文「网络连接失败」并带 NET-0001，而不是浏览器原文 Failed to fetch', async () => {
    const api = load<(p: string) => Promise<unknown>>(['api'], 'api', {
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      state: { session: null },
      showLogin: () => {},
    })
    await expect(api('/admin/api/agents')).rejects.toMatchObject({ message: '网络连接失败', code: 'NET-0001' })
  })

  it.each(['Failed to fetch', 'Load failed'])('读响应体时断网（text() 抛 TypeError：%s）也抛中文「网络连接失败」+ NET-0001，不显示原文', async (raw) => {
    const api = load<(p: string) => Promise<unknown>>(['api'], 'api', {
      fetch: () => Promise.resolve({ status: 200, ok: true, text: () => Promise.reject(new TypeError(raw)) }),
      state: { session: null },
      showLogin: () => {},
    })
    const err = await api('/admin/api/approvals').catch((e: unknown) => e)
    expect(err).toMatchObject({ message: '网络连接失败', code: 'NET-0001' })
    expect(err).not.toBeInstanceOf(TypeError)
    expect((err as Error).message).not.toContain(raw)
  })

  it('读响应体时被 abort 原样抛出', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    const api = load<(p: string) => Promise<unknown>>(['api'], 'api', {
      fetch: () => Promise.resolve({ status: 200, ok: true, text: () => Promise.reject(abort) }),
      state: { session: null },
      showLogin: () => {},
    })
    await expect(api('/admin/api/approvals')).rejects.toBe(abort)
  })
})
