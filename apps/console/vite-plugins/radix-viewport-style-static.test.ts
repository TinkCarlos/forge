import { readFileSync, realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * FE-CSP-04：Radix ScrollArea（⌘K 用）和 Select（分页每页条数）的 Viewport 在运行时渲染
 * <style dangerouslySetInnerHTML>（隐藏原生滚动条），/next/ 的 style-src 'self' 会拦下（style-src-elem inline）。
 * 构建时把这个 <style> 元素换成 null，同样的规则写进 src/styles/radix-viewport.css 静态引入。
 * 补丁锁版本：包版本或被替换的源码片段对不上 → 构建失败，升级 Radix 时必须重新核对。
 */
const load = async () =>
  (await import('./radix-viewport-style-static')) as {
    RADIX_VIEWPORT_PATCHES: readonly { pkg: string; version: string; css: string }[]
    patchRadixViewportStyle(code: string, id: string, version: string): string | null
    radixViewportStyleStatic(): { name: string; enforce?: string; transform: (code: string, id: string) => unknown }
  }

// 和构建时一样用真实路径（.pnpm/<名@版本_peer>/node_modules/<包>）
const real = (pkg: string) => {
  const dir = realpathSync(new URL(`../node_modules/${pkg}`, import.meta.url).pathname)
  const file = `${dir}/dist/index.mjs`
  return { file, src: readFileSync(file, 'utf8'), version: (JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as { version: string }).version }
}

describe('FE-CSP-04 Radix Viewport 不在运行时插 <style>', () => {
  it('锁定的两个包和版本', async () => {
    expect((await load()).RADIX_VIEWPORT_PATCHES.map((p) => `${p.pkg}@${p.version}`)).toEqual(['@radix-ui/react-scroll-area@1.4.0', '@radix-ui/react-select@2.4.1'])
  })

  it.each(['@radix-ui/react-scroll-area', '@radix-ui/react-select'])('%s：真实产物里的 <style> 元素被换成 null，其余不变', async (pkg) => {
    const m = await load()
    const { file, src, version } = real(pkg)
    expect(src).toMatch(/jsx\(\s*"style",\s*\{\s*dangerouslySetInnerHTML/)
    const out = m.patchRadixViewportStyle(src, file, version)
    expect(out).not.toBeNull()
    expect(out).not.toMatch(/dangerouslySetInnerHTML/)
    expect(out).not.toMatch(/"style"/)
    expect(src.length - out!.length).toBeGreaterThan(150)
  })

  it('不相关模块原样放过（返回 null）', async () => {
    expect((await load()).patchRadixViewportStyle('export const x = 1', '/w/node_modules/@radix-ui/react-dialog/dist/index.mjs', '1.1.0')).toBeNull()
  })

  it('版本对不上 → 抛错（构建失败），错误里写明锁定的版本', async () => {
    const m = await load()
    const { file, src } = real('@radix-ui/react-scroll-area')
    expect(() => m.patchRadixViewportStyle(src, file, '1.4.1')).toThrow(/forge:radix-viewport-style-static.*1\.4\.1.*1\.4\.0/s)
  })

  it('源码片段对不上（被注入的 CSS 变了，或写法变了）→ 抛错', async () => {
    const m = await load()
    const { file, src, version } = real('@radix-ui/react-select')
    expect(() => m.patchRadixViewportStyle(src.replace('scrollbar-width:none;', 'scrollbar-width:thin;'), file, version)).toThrow(/forge:radix-viewport-style-static/)
    expect(() => m.patchRadixViewportStyle(src.replace(/dangerouslySetInnerHTML/g, 'x'), file, version)).toThrow(/forge:radix-viewport-style-static/)
  })

  it('同样的规则静态写进 radix-viewport.css，并由 index.css 引入', async () => {
    const css = readFileSync(new URL('../src/styles/radix-viewport.css', import.meta.url), 'utf8')
    for (const p of (await load()).RADIX_VIEWPORT_PATCHES) expect(css).toContain(p.css)
    expect(readFileSync(new URL('../src/styles/index.css', import.meta.url), 'utf8')).toMatch(/@import '\.\/radix-viewport\.css';/)
  })

  it('插件 enforce:pre，vite.config 已注册', async () => {
    const p = (await load()).radixViewportStyleStatic()
    expect(p.name).toBe('forge:radix-viewport-style-static')
    expect(p.enforce).toBe('pre')
    expect(readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')).toMatch(/radixViewportStyleStatic\(\)/)
  })
})
