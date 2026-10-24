import type { Plugin } from 'vite'

/**
 * K-33：新控制台经 alias 直接引用 packages/core/src/ids.ts 的 ID_PATTERN / ID_PATTERN_SOURCE。
 * ids.ts 顶部 import 了 ulid（只给服务端的 ulidWithPrefix 用）；ulid 模块顶层就调 factory()，打包器判定有副作用，
 * 即使没用到也会整包打进 vendor-misc（实测）。
 *
 * 1) 只在 importer 是 packages/core/src/ids.ts 时，把 ulid 标成无副作用，没用到就被 tree-shake 掉；
 * 2) 产物守卫：任何 chunk 里出现 ulid，或出现 packages/ 下除 core/src/ids.ts 以外的模块（服务端代码），构建直接失败。
 */
const IDS_MODULE = /[\\/]packages[\\/]core[\\/]src[\\/]ids\.ts$/
const SERVER_MODULE = /[\\/]packages[\\/]/
const ULID_MODULE = /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?ulid[\\/]/

export function serverCodeInChunks(chunks: Record<string, readonly string[]>): string[] {
  const bad: string[] = []
  for (const [file, ids] of Object.entries(chunks)) {
    for (const id of ids) {
      const clean = id.split('?')[0].replace(/^\0/, '')
      if (ULID_MODULE.test(clean) || (SERVER_MODULE.test(clean) && !IDS_MODULE.test(clean))) bad.push(`${file}: ${clean}`)
    }
  }
  return bad
}

export function coreIdsOnly(): Plugin {
  return {
    name: 'forge:core-ids-only',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source !== 'ulid' || !importer || !IDS_MODULE.test(importer)) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      return resolved ? { ...resolved, moduleSideEffects: false } : null
    },
    generateBundle(_options, bundle) {
      const chunks: Record<string, string[]> = {}
      for (const [file, out] of Object.entries(bundle)) if (out.type === 'chunk') chunks[file] = Object.keys(out.modules)
      const bad = serverCodeInChunks(chunks)
      if (bad.length) this.error(`[forge:core-ids-only] 产物里混进了服务端代码（只允许 packages/core/src/ids.ts 的常量）：\n${bad.join('\n')}`)
    },
  }
}
