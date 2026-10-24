import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

/**
 * FE-CSP-04：Radix ScrollArea（⌘K 命令面板）和 Select（分页每页条数）的 Viewport 渲染
 * <style dangerouslySetInnerHTML>（隐藏原生滚动条），/next/ 的 style-src 'self' 会拦下（style-src-elem inline）。
 * 构建时把这个 <style> 元素换成 null；同样的规则静态写在 src/styles/radix-viewport.css。
 *
 * 补丁锁版本：包版本不是下面锁定的版本、或被替换的源码片段（含 CSS 原文）一处都对不上 → 抛错，构建失败。
 * 升级这两个包时：核对新版 dist/index.mjs 里的 <style>，同步更新 version / css 和 radix-viewport.css。
 */
export const RADIX_VIEWPORT_PATCHES = [
  {
    pkg: '@radix-ui/react-scroll-area',
    version: '1.4.0',
    css: '[data-radix-scroll-area-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-scroll-area-viewport]::-webkit-scrollbar{display:none}',
  },
  {
    pkg: '@radix-ui/react-select',
    version: '2.4.1',
    css: '[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}',
  },
] as const

const NAME = 'forge:radix-viewport-style-static'
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 命中锁定包的 dist 入口，返回包信息和包目录；否则 undefined。 */
function matchModule(id: string) {
  const path = id.replace(/\\/g, '/').replace(/\?.*$/, '')
  for (const p of RADIX_VIEWPORT_PATCHES) {
    const m = path.match(new RegExp(`^(.*/node_modules/${escape(p.pkg)})/dist/index\\.(?:mjs|js)$`))
    if (m) return { patch: p, dir: m[1] }
  }
  return undefined
}

/**
 * 把 jsx("style", { dangerouslySetInnerHTML: { __html: `<锁定的 CSS>` }, nonce }) 换成 null。
 * 不是锁定的模块 → null（不处理）；版本或片段对不上 → 抛错。
 */
export function patchRadixViewportStyle(code: string, id: string, version: string): string | null {
  const hit = matchModule(id)
  if (!hit) return null
  const { patch } = hit
  if (version !== patch.version)
    throw new Error(`[${NAME}] ${patch.pkg} 版本是 ${version}，补丁锁定的是 ${patch.version}：请核对新版 <style> 注入后更新 vite-plugins/radix-viewport-style-static.ts 和 src/styles/radix-viewport.css`)
  const re = new RegExp(
    String.raw`(?:/\* @__PURE__ \*/ )?(?:\(0,\s*[\w$]+\.jsx\)|jsx)\(\s*"style",\s*\{\s*dangerouslySetInnerHTML:\s*\{\s*__html:\s*` +
      '`' + escape(patch.css) + '`' + String.raw`\s*\},\s*nonce\s*\}\s*\)`,
    'g',
  )
  let n = 0
  const out = code.replace(re, () => (n++, 'null'))
  if (n !== 1 || /dangerouslySetInnerHTML/.test(out))
    throw new Error(`[${NAME}] ${patch.pkg}@${version} 里要替换的 <style> 片段匹配到 ${n} 处（应为 1 处，且替换后不应再有 dangerouslySetInnerHTML）：源码或 CSS 变了，请重新核对`)
  return out
}

export function radixViewportStyleStatic(): Plugin {
  const patched = new Set<string>()
  return {
    name: NAME,
    enforce: 'pre',
    transform(code, id) {
      const hit = matchModule(id)
      if (!hit) return null
      const { version } = JSON.parse(readFileSync(`${hit.dir}/package.json`, 'utf8')) as { version: string }
      const out = patchRadixViewportStyle(code, id, version)
      patched.add(hit.patch.pkg)
      return out === null ? null : { code: out, map: null }
    },
    buildEnd(err) {
      if (err || this.meta.watchMode) return
      // 模块图里有锁定的包、却没经过 transform（比如 dist 入口改名）→ 补丁没生效，同样让构建失败
      for (const id of this.getModuleIds()) {
        const path = id.replace(/\\/g, '/')
        for (const p of RADIX_VIEWPORT_PATCHES)
          if (path.includes(`/node_modules/${p.pkg}/`) && !patched.has(p.pkg)) this.error(`[${NAME}] 构建用到了 ${p.pkg}（${path}），但补丁没打上`)
      }
    },
  }
}
