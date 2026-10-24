import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OPS-019 补：shell 里带着 NODE_ENV=development/test（testenv 的 .env 都这么写）跑 vite build，
 * Vite 会把 process.env.NODE_ENV 替换成 'development'，React 打进开发版，vendor-react 从 206.76 kB 涨到 395.21 kB，
 * 和 chunk 分组无关。build 脚本固定 NODE_ENV=production；绕过脚本直接 vite build 且不是 production → 构建直接失败并说明原因。
 */
const load = async () =>
  (await import('./production-build-guard')) as {
    productionBuildProblem(input: { command: string; isProduction: boolean; nodeEnv: string | undefined }): string | undefined
    productionBuildGuard(): { name: string; apply?: unknown; configResolved?: (config: { command: string; isProduction: boolean }) => void }
  }

describe('productionBuildProblem', () => {
  it('build + production → 没问题', async () => {
    expect((await load()).productionBuildProblem({ command: 'build', isProduction: true, nodeEnv: 'production' })).toBeUndefined()
  })
  it.each(['development', 'test'])('build 但 NODE_ENV=%s → 报出 NODE_ENV 和后果', async (env) => {
    const msg = (await load()).productionBuildProblem({ command: 'build', isProduction: false, nodeEnv: env })
    expect(msg).toContain(`NODE_ENV=${env}`)
    expect(msg).toMatch(/React 开发版/)
  })
  it('dev server（serve）不管', async () => {
    expect((await load()).productionBuildProblem({ command: 'serve', isProduction: false, nodeEnv: 'development' })).toBeUndefined()
  })
  it('插件在 configResolved 里抛错，让构建失败', async () => {
    const p = (await load()).productionBuildGuard()
    expect(p.name).toBe('forge:production-build-guard')
    expect(() => p.configResolved!({ command: 'build', isProduction: false })).toThrow(/forge:production-build-guard/)
    expect(() => p.configResolved!({ command: 'build', isProduction: true })).not.toThrow()
  })
})

describe('接线', () => {
  it('vite.config.ts 挂 productionBuildGuard()', () => {
    expect(readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')).toMatch(/productionBuildGuard\(\)/)
  })
  it('build 脚本固定 NODE_ENV=production（shell 里 source 过 NODE_ENV=development 的 .env 也照样出生产包）', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.build).toMatch(/NODE_ENV=production vite build/)
  })
})
