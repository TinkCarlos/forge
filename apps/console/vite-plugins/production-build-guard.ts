import type { Plugin } from 'vite'

/**
 * OPS-019 补：vite build 时只要 NODE_ENV 不是 production（比如 source 了写着 NODE_ENV=development 的 .env），
 * Vite 就把 process.env.NODE_ENV 替换成 'development'，React / React DOM 打进开发版，vendor-react 395.21 kB 超过单块 250 kB。
 * build 脚本已固定 NODE_ENV=production；这里兜底：绕过脚本直接 vite build 且不是 production 时直接失败，并说清原因。
 */
export function productionBuildProblem({ command, isProduction, nodeEnv }: { command: string; isProduction: boolean; nodeEnv: string | undefined }): string | undefined {
  if (command !== 'build' || isProduction) return undefined
  return `vite build 时 NODE_ENV=${nodeEnv ?? '(未设置)'}，不是 production：React 开发版会被打进 vendor-react（实测 395.21 kB），产物不能上线。请用 pnpm build（脚本固定 NODE_ENV=production），或先 unset NODE_ENV。`
}

export function productionBuildGuard(): Plugin {
  return {
    name: 'forge:production-build-guard',
    apply: 'build',
    configResolved(config) {
      const problem = productionBuildProblem({ command: config.command, isProduction: config.isProduction, nodeEnv: process.env.NODE_ENV })
      if (problem) throw new Error(`[forge:production-build-guard] ${problem}`)
    },
  }
}
