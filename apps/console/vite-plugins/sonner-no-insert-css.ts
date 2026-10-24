import type { Plugin } from 'vite'

/**
 * FE-CSP-01：sonner 2.x 在模块加载时用 __insertCSS 往 <head> 插 <style>，
 * 在 /next/ 的 style-src 'self' 下被 CSP 拦掉（style-src-elem 违规），toast 失去样式。
 * 这里只对 sonner 的产物去掉这次调用，样式改由 src/styles/index.css 静态引入 sonner/dist/styles.css。
 */
const CALL = /__insertCSS\("(?:[^"\\]|\\.)*"\);?/g

export function stripSonnerInsertCss(code: string): { code: string; removed: number } {
  let removed = 0
  const out = code.replace(CALL, () => {
    removed++
    return ''
  })
  return { code: out, removed }
}

export function sonnerNoInsertCss(): Plugin {
  return {
    name: 'forge:sonner-no-insert-css',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?sonner[\\/]dist[\\/]index\.m?js/.test(id)) return null
      const { code: out, removed } = stripSonnerInsertCss(code)
      // sonner 升级后写法变了就提醒，不要静默失效
      if (removed === 0) this.warn('sonner: 没找到 __insertCSS 调用，FE-CSP-01 的去除未生效，请检查 CSP 违规')
      return { code: out, map: null }
    },
  }
}
