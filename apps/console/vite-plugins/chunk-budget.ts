import type { Plugin } from 'vite'

/**
 * OPS-019：第三方依赖按包拆成固定的 vendor 块（react / radix / tanstack / zod / motion / misc），业务代码仍交给 TanStack Router 的 autoCodeSplitting。
 * 只对 node_modules 下的模块返回块名；其它（src、虚拟模块）返回 undefined，按默认规则拆。
 */
const GROUPS: [RegExp, string][] = [
  [/^(?:react|react-dom|scheduler)$/, 'vendor-react'],
  [/^@radix-ui\//, 'vendor-radix'],
  [/^@tanstack\//, 'vendor-tanstack'],
  [/^zod$/, 'vendor-zod'],
  // 只按 5 组拆时 vendor-misc 276.65 kB，超过单块 250 kB；motion（framer-motion 约 125 kB）单独成块后两块都在线内
  [/^(?:motion|framer-motion|motion-dom|motion-utils)$/, 'vendor-motion'],
]

export function vendorChunk(id: string): string | undefined {
  const path = id.replace(/\\/g, '/')
  const at = path.lastIndexOf('/node_modules/')
  if (at === -1) return undefined
  const rest = path.slice(at + '/node_modules/'.length).split('/')
  const pkg = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]
  return GROUPS.find(([re]) => re.test(pkg))?.[1] ?? 'vendor-misc'
}

/** 未压缩字节，1 kB = 1000 B（和 vite build 输出一致）。 */
export const CHUNK_BUDGET = { entry: 200_000, chunk: 250_000 }

const kb = (n: number) => `${(n / 1000).toFixed(2)} kB`

export function checkChunkBudget(
  chunks: { fileName: string; size: number; isEntry: boolean }[],
  budget: { entry: number; chunk: number } = CHUNK_BUDGET,
): string[] {
  const out: string[] = []
  for (const c of chunks) {
    const limit = c.isEntry ? budget.entry : budget.chunk
    if (c.size > limit) out.push(`${c.fileName}${c.isEntry ? '（入口）' : ''} ${kb(c.size)} 超过 ${limit / 1000} kB`)
  }
  return out
}

/** 构建时检查 chunk 体积，超了就让 vite build 失败。 */
export function chunkBudget(): Plugin {
  return {
    name: 'forge:chunk-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter((o) => o.type === 'chunk')
        .map((c) => ({ fileName: c.fileName, size: Buffer.byteLength(c.code, 'utf8'), isEntry: c.isEntry }))
      const problems = checkChunkBudget(chunks)
      if (problems.length) throw new Error(`[forge:chunk-budget] OPS-019 chunk 体积超标（入口 ≤200 kB、单块 ≤250 kB，未压缩）：\n  ${problems.join('\n  ')}`)
    },
  }
}
