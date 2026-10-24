import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * CSP 产物断言：/next/ 是 script-src 'self' / style-src 'self'，构建产物里出现内联脚本、内联样式
 * （<script> 无 src、<style>、style= 属性、on*= 事件属性、javascript: 地址，或入口 JS 里运行时插 <style> 的代码）
 * 就让 vite build 失败，而不是等上线后在浏览器里报违规。
 */
const load = async () =>
  (await import('./no-inline-artifacts')) as {
    findHtmlViolations(html: string): string[]
    findCssViolations(css: string): string[]
    findJsViolations(js: string): string[]
    entryAssets(html: string, base: string): string[]
    assertDistClean(dir: string, base: string): void
  }

const CLEAN_HTML = `<!doctype html><html><head>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" />
<script type="module" crossorigin src="/next/assets/index-a.js"></script>
<link rel="modulepreload" crossorigin href="/next/assets/vendor-b.js">
<link rel="stylesheet" crossorigin href="/next/assets/index-c.css">
</head><body><div id="root"></div></body></html>`

describe('HTML / CSS 规则', () => {
  it('干净的入口 HTML 没有违规', async () => {
    expect((await load()).findHtmlViolations(CLEAN_HTML)).toEqual([])
  })

  it.each([
    ['内联 <script>', '<script>window.x=1</script>'],
    ['内联 module script', '<script type="module">import "/a.js"</script>'],
    ['<style> 标签', '<style>body{color:red}</style>'],
    ['style 属性', '<div style="color:red"></div>'],
    ['事件属性', '<img src="/a.png" onerror="alert(1)">'],
    ['javascript: 地址', '<a href="javascript:alert(1)">x</a>'],
  ])('%s 会被报出来', async (_l, snippet) => {
    const v = (await load()).findHtmlViolations(CLEAN_HTML.replace('<div id="root"></div>', snippet))
    expect(v.length).toBeGreaterThan(0)
  })

  it('CSS 里不能带 javascript: / expression()，普通 CSS 通过', async () => {
    const m = await load()
    expect(m.findCssViolations('.a{color:red}@media (min-width:1px){.b{display:none}}')).toEqual([])
    expect(m.findCssViolations('.a{background:url(javascript:alert(1))}').length).toBeGreaterThan(0)
    expect(m.findCssViolations('.a{width:expression(alert(1))}').length).toBeGreaterThan(0)
  })
})

describe('入口 JS 规则', () => {
  it('入口 HTML 引用的 JS/CSS 按 base 解析出来', async () => {
    expect((await load()).entryAssets(CLEAN_HTML, '/next/')).toEqual(['assets/index-a.js', 'assets/vendor-b.js', 'assets/index-c.css'])
  })

  it('sonner 原版 __insertCSS（未经 FE-CSP-01 处理）会被报出来', async () => {
    const sonner = readFileSync(new URL('../node_modules/sonner/dist/index.mjs', import.meta.url), 'utf8')
    expect((await load()).findJsViolations(sonner).length).toBeGreaterThan(0)
  })

  it('react-style-singleton 原版（未经 FE-CSP-03 处理）的 <style> 注入会被报出来', async () => {
    const js = 'function makeStyleTag(){var t=document.createElement("style");t.type="text/css";return t}function inject(t,c){t.styleSheet?t.styleSheet.cssText=c:t.appendChild(document.createTextNode(c))}'
    expect((await load()).findJsViolations(js).length).toBeGreaterThan(0)
  })

  it('Radix Viewport 原版（未经 FE-CSP-04 处理）的 <style dangerouslySetInnerHTML> 会被报出来', async () => {
    const js = 'io=I.memo(Z(function({nonce:e}){return(0,L.jsx)(`style`,{dangerouslySetInnerHTML:{__html:`[data-radix-scroll-area-viewport]{scrollbar-width:none}`},nonce:e})}))'
    expect((await load()).findJsViolations(js)).toEqual(['React 渲染 <style dangerouslySetInnerHTML> 注入内联样式（FE-CSP-04 未生效）'])
  })

  it('setAttribute("style", …) 会被报出来', async () => {
    expect((await load()).findJsViolations('el.setAttribute("style","color:red")').length).toBeGreaterThan(0)
  })

  it('React DOM 自带的惰性写法不误报（innerHTML="<script></script>"、hoistable <style>、oninput 特性探测）', async () => {
    const js = 'e=n.createElement(`div`),e.innerHTML=`<script><\\/script>`,e=e.removeChild(e.firstChild);r=(e.ownerDocument||e).createElement(`style`),N(r),np(r,`style`,a);var Ir=document.createElement(`div`);Ir.setAttribute(`oninput`,`return;`)'
    expect((await load()).findJsViolations(js)).toEqual([])
  })
})

describe('assertDistClean：有违规就抛错（构建失败）', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const dist = (html: string, files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), 'csp-dist-'))
    dirs.push(d)
    mkdirSync(join(d, 'assets'))
    writeFileSync(join(d, 'index.html'), html)
    for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c)
    return d
  }
  const ok = { 'assets/index-a.js': 'console.log(1)', 'assets/vendor-b.js': 'export{}', 'assets/index-c.css': '.a{color:red}' }

  it('干净的产物通过', async () => {
    const m = await load()
    expect(() => m.assertDistClean(dist(CLEAN_HTML, ok), '/next/')).not.toThrow()
  })

  it('入口 HTML 有内联脚本 → 抛错并点名文件', async () => {
    const m = await load()
    const d = dist(CLEAN_HTML.replace('</body>', '<script>1</script></body>'), ok)
    expect(() => m.assertDistClean(d, '/next/')).toThrow(/index\.html[\s\S]*内联/)
  })

  it('入口预加载的 JS 里有运行时插 <style> → 抛错并点名文件', async () => {
    const m = await load()
    const d = dist(CLEAN_HTML, { ...ok, 'assets/vendor-b.js': 'var s=document.createElement("style");s.type="text/css";document.head.appendChild(s)' })
    expect(() => m.assertDistClean(d, '/next/')).toThrow(/vendor-b\.js/)
  })

  it('assets 下任意 CSS 有违规也抛错', async () => {
    const m = await load()
    const d = dist(CLEAN_HTML, { ...ok, 'assets/lazy-d.css': '.x{background:url(javascript:1)}' })
    expect(() => m.assertDistClean(d, '/next/')).toThrow(/lazy-d\.css/)
  })
})

describe('插件钩子', () => {
  it('没写出产物（前面的插件已让构建失败）时 closeBundle 不检查，不用 ENOENT 盖住真正的错误', async () => {
    const m = (await import('./no-inline-artifacts')) as unknown as { noInlineArtifacts(): Record<string, (...a: unknown[]) => unknown> }
    const p = m.noInlineArtifacts()
    p.configResolved({ root: '/nonexistent-forge-root', base: '/next/', build: { outDir: 'dist' } })
    expect(() => p.closeBundle()).not.toThrow()
    p.writeBundle()
    expect(() => p.closeBundle()).toThrow(/ENOENT/)
  })
})

describe('接进构建', () => {
  it('vite.config.ts 挂了 noInlineArtifacts()，保留 FE-CSP-01/03 两个插件', () => {
    const cfg = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
    expect(cfg).toMatch(/noInlineArtifacts\(\)/)
    expect(cfg).toMatch(/sonnerNoInsertCss\(\)/)
    expect(cfg).toMatch(/styleSingletonAdopted\(\)/)
  })
})
