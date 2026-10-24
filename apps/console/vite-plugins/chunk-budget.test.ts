import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OPS-019：node_modules 按 vendor-react / vendor-radix / vendor-tanstack / vendor-zod / vendor-motion / vendor-misc 拆块，
 * （motion 单独成块：只拆 5 组时 vendor-misc 276.65 kB 超过 250 kB）
 * 业务代码仍走 TanStack Router autoCodeSplitting；构建时入口 chunk ≤200 kB、任一 chunk ≤250 kB（未压缩），超了构建失败。
 */
const load = async () =>
  (await import('./chunk-budget')) as {
    vendorChunk(id: string): string | undefined
    checkChunkBudget(chunks: { fileName: string; size: number; isEntry: boolean }[], budget?: { entry: number; chunk: number }): string[]
    CHUNK_BUDGET: { entry: number; chunk: number }
  }

const pnpm = (pkg: string, file = 'index.js') => `/repo/node_modules/.pnpm/${pkg.replace('/', '+')}@1.0.0/node_modules/${pkg}/dist/${file}`

describe('vendorChunk 分组', () => {
  it.each([
    [pnpm('react'), 'vendor-react'],
    ['/repo/node_modules/react-dom/cjs/react-dom-client.production.js', 'vendor-react'],
    [pnpm('scheduler'), 'vendor-react'],
    [pnpm('@radix-ui/react-dialog'), 'vendor-radix'],
    [pnpm('@tanstack/react-router'), 'vendor-tanstack'],
    [pnpm('@tanstack/query-core'), 'vendor-tanstack'],
    [pnpm('zod', 'v4/classic/schemas.js'), 'vendor-zod'],
    [pnpm('motion'), 'vendor-motion'],
    [pnpm('framer-motion'), 'vendor-motion'],
    [pnpm('motion-dom'), 'vendor-motion'],
    [pnpm('sonner'), 'vendor-misc'],
    [pnpm('lucide-react'), 'vendor-misc'],
    [pnpm('react-remove-scroll'), 'vendor-misc'],
    ['C:\\repo\\node_modules\\@radix-ui\\react-popover\\dist\\index.mjs', 'vendor-radix'],
  ])('%s → %s', async (id, chunk) => {
    expect((await load()).vendorChunk(id)).toBe(chunk)
  })

  it.each(['/repo/apps/console/src/main.tsx', '/repo/apps/console/src/features/agents/index.tsx', '\0rolldown/runtime.js', '/repo/apps/console/src/routes/_authenticated/route.tsx?tsr-split=component'])(
    '业务代码 / 虚拟模块 %s 不进 vendor 块（交给 autoCodeSplitting）',
    async (id) => {
      expect((await load()).vendorChunk(id)).toBeUndefined()
    },
  )
})

describe('checkChunkBudget', () => {
  it('阈值：入口 200 kB、单块 250 kB（未压缩，1 kB = 1000 B，和 vite 输出一致）', async () => {
    expect((await load()).CHUNK_BUDGET).toEqual({ entry: 200_000, chunk: 250_000 })
  })

  it('都在阈值内 → 无问题', async () => {
    const m = await load()
    expect(m.checkChunkBudget([{ fileName: 'assets/index.js', size: 199_999, isEntry: true }, { fileName: 'assets/vendor-react.js', size: 250_000, isEntry: false }])).toEqual([])
  })

  it('入口超 200 kB、其它块超 250 kB → 点名报出', async () => {
    const m = await load()
    const out = m.checkChunkBudget([
      { fileName: 'assets/index-a.js', size: 352_790, isEntry: true },
      { fileName: 'assets/sidebar-b.js', size: 250_001, isEntry: false },
      { fileName: 'assets/ok.js', size: 1000, isEntry: false },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatch(/index-a\.js.*352\.79 kB.*200 kB/)
    expect(out[1]).toMatch(/sidebar-b\.js.*250\.00 kB.*250 kB/)
  })
})

describe('vite.config.ts 接线', () => {
  const cfg = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
  it('manualChunks 用 vendorChunk，挂 chunkBudget()；base / publicDir / CSP 插件 / autoCodeSplitting 不变', () => {
    expect(cfg).toMatch(/manualChunks:\s*vendorChunk/)
    expect(cfg).toMatch(/chunkBudget\(\)/)
    expect(cfg).toMatch(/base: '\/next\/'/)
    expect(cfg).toMatch(/publicDir: false/)
    expect(cfg).toMatch(/autoCodeSplitting: true/)
    expect(cfg).toMatch(/sonnerNoInsertCss\(\)/)
    expect(cfg).toMatch(/styleSingletonAdopted\(\)/)
    expect(cfg).toMatch(/noInlineArtifacts\(\)/)
    expect(cfg).not.toMatch(/entryFileNames|chunkFileNames|assetFileNames/)
  })
})
