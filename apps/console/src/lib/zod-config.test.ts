import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

const RealFunction = globalThis.Function
afterEach(() => {
  globalThis.Function = RealFunction
})

describe('FE-CSP-02 zod 不探测 eval', () => {
  it('引入 zod-config 后，解析对象 schema 不调用 new Function（严格 CSP 下不触发 script-src 违规）', async () => {
    let constructed = 0
    globalThis.Function = new Proxy(RealFunction, {
      construct(target, args) {
        constructed++
        return Reflect.construct(target, args)
      },
    })
    await import('./zod-config')
    const { z } = await import('zod')
    const schema = z.object({ username: z.string().min(1), note: z.string().min(1) })
    expect(schema.safeParse({ username: 'a', note: 'b' }).success).toBe(true)
    expect(constructed).toBe(0)
  })

  it('main.tsx 第一条 import 就是 zod-config（早于任何定义 schema 的模块）', () => {
    const src = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
    const first = src.match(/^import\s.*$/m)?.[0]
    expect(first).toMatch(/['"]@?\.?\/?(lib\/)?zod-config['"]|['"]\.\/lib\/zod-config['"]/)
  })
})
