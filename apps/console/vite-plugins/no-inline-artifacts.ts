import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

/**
 * CSP 产物断言：/next/ 的 CSP 是 script-src 'self' / style-src 'self'（无 unsafe-inline）。
 * 构建结束后检查 dist：入口 HTML、assets 下全部 CSS、入口 HTML 引用（script / modulepreload）的 JS，
 * 出现内联脚本或注入式内联样式就抛错，让 vite build 失败。
 * JS 只认「运行时往 <head> 插 <style>」的写法（FE-CSP-01 sonner __insertCSS、FE-CSP-03 react-style-singleton），
 * 不把 React DOM 自带的惰性分支（innerHTML="<script></script>"、hoistable <style>、oninput 特性探测）算进去。
 */

const TAG = /<[a-zA-Z][^>]*>/g

export function findHtmlViolations(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\ssrc\s*=/i.test(m[1])) out.push(`内联 <script>：${m[0].slice(0, 80)}`)
  }
  for (const m of html.matchAll(/<style\b[^>]*>/gi)) out.push(`内联 <style>：${m[0].slice(0, 80)}`)
  for (const m of html.matchAll(TAG)) {
    const tag = m[0]
    if (/\sstyle\s*=/i.test(tag)) out.push(`内联 style 属性：${tag.slice(0, 80)}`)
    const handler = tag.match(/\s(on[a-z]+)\s*=/i)
    if (handler) out.push(`内联事件属性 ${handler[1]}：${tag.slice(0, 80)}`)
    if (/\s(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/i.test(tag)) out.push(`内联 javascript: 地址：${tag.slice(0, 80)}`)
  }
  return out
}

export function findCssViolations(css: string): string[] {
  const out: string[] = []
  if (/javascript:/i.test(css)) out.push('CSS 含 javascript: 地址')
  if (/expression\s*\(/i.test(css)) out.push('CSS 含 expression()')
  return out
}

const JS_RULES: [RegExp, string][] = [
  [/\.type\s*=\s*["'`]text\/css["'`]/, '运行时创建 <style type="text/css"> 注入内联样式'],
  [/\.styleSheet\.cssText\s*=/, '运行时写 styleSheet.cssText 注入内联样式'],
  [/\b__insertCSS\s*\(\s*["'`]/, 'sonner __insertCSS 注入内联样式（FE-CSP-01 未生效）'],
  // 只认 style：React DOM 有一处 setAttribute(`oninput`) 的特性探测（仅在没有 oninput 的旧浏览器上执行），不算违规
  [/\.setAttribute\(\s*["'`]style["'`]/, 'setAttribute 写内联 style 属性'],
  [/\(\s*["'`]style["'`]\s*,\s*\{\s*dangerouslySetInnerHTML\b/, 'React 渲染 <style dangerouslySetInnerHTML> 注入内联样式（FE-CSP-04 未生效）'],
]

export function findJsViolations(js: string): string[] {
  return JS_RULES.filter(([re]) => re.test(js)).map(([, msg]) => msg)
}

/** 入口 HTML 引用的本地 JS / CSS（script src、modulepreload、stylesheet），返回相对 dist 的路径。 */
export function entryAssets(html: string, base: string): string[] {
  const urls: string[] = []
  for (const m of html.matchAll(/<script\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi)) urls.push(m[1])
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = m[0].match(/\srel\s*=\s*["']([^"']+)["']/i)?.[1] ?? ''
    const href = m[0].match(/\shref\s*=\s*["']([^"']+)["']/i)?.[1]
    if (href && /^(?:modulepreload|stylesheet)$/i.test(rel)) urls.push(href)
  }
  return urls
    .filter((u) => !/^(?:[a-z]+:)?\/\//i.test(u) && !u.startsWith('data:'))
    .map((u) => (u.startsWith(base) ? u.slice(base.length) : u.replace(/^\//, '')))
}

export function assertDistClean(dir: string, base: string): void {
  const problems: string[] = []
  const report = (file: string, list: string[]) => list.forEach((p) => problems.push(`  ${file}: ${p}`))
  const html = readFileSync(join(dir, 'index.html'), 'utf8')
  report('index.html', findHtmlViolations(html))
  const entries = entryAssets(html, base)
  for (const rel of entries.filter((f) => f.endsWith('.js'))) {
    const p = join(dir, rel)
    if (!existsSync(p)) problems.push(`  ${rel}: 入口 HTML 引用的文件不存在`)
    else report(rel, findJsViolations(readFileSync(p, 'utf8')))
  }
  const assets = join(dir, 'assets')
  if (existsSync(assets)) {
    for (const f of readdirSync(assets).filter((n) => n.endsWith('.css'))) report(`assets/${f}`, findCssViolations(readFileSync(join(assets, f), 'utf8')))
  }
  if (problems.length) {
    throw new Error(`[forge:no-inline-artifacts] 构建产物含内联脚本/内联样式，/next/ 的 CSP（script-src/style-src 'self'）会拦截：\n${problems.join('\n')}`)
  }
}

export function noInlineArtifacts(): Plugin {
  let config: ResolvedConfig | undefined
  let written = false
  return {
    name: 'forge:no-inline-artifacts',
    apply: 'build',
    configResolved(c) {
      config = c
    },
    writeBundle() {
      written = true
    },
    // 前面的插件已经让构建失败（没写出产物）时不再检查，免得 ENOENT 盖住真正的错误
    closeBundle() {
      if (!config || !written) return
      written = false
      assertDistClean(resolve(config.root, config.build.outDir), config.base)
    },
  }
}
