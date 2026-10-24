import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ADOPTED_SINGLETON, isStyleSingletonModule } from './style-singleton-adopted'

class FakeSheet {
  css = ''
  replaceSync(css: string) {
    this.css = css
  }
}

function load() {
  const doc = { adoptedStyleSheets: [] as FakeSheet[], createElement: () => { throw new Error('不应创建 <style>') } }
  const mod = { stylesheetSingleton: undefined as unknown as () => { add(s: string): void; remove(): void } }
  // 把替换后的 ESM 当普通脚本跑：去掉 export 关键字
  new Function('document', 'CSSStyleSheet', 'mod', ADOPTED_SINGLETON.replace('export var stylesheetSingleton', 'mod.stylesheetSingleton'))(doc, FakeSheet, mod)
  return { doc, singleton: mod.stylesheetSingleton }
}

describe('FE-CSP-03 Radix 弹层的滚动锁样式不用 <style>', () => {
  it('只匹配 react-style-singleton 的 singleton 模块', () => {
    expect(isStyleSingletonModule('/x/node_modules/.pnpm/react-style-singleton@2.2.3_r/node_modules/react-style-singleton/dist/es2015/singleton.js')).toBe(true)
    expect(isStyleSingletonModule('/x/node_modules/react-style-singleton/dist/es5/singleton.js')).toBe(true)
    expect(isStyleSingletonModule('/x/node_modules/react-style-singleton/dist/es2015/hook.js')).toBe(false)
    expect(isStyleSingletonModule('/x/src/singleton.js')).toBe(false)
  })

  it('add/remove 用 adoptedStyleSheets，按引用计数挂载和移除，保留其它样式表', () => {
    const { doc, singleton } = load()
    const other = new FakeSheet()
    doc.adoptedStyleSheets = [other]
    const s = singleton()
    s.add('body{overflow:hidden!important}')
    s.add('ignored')
    expect(doc.adoptedStyleSheets).toHaveLength(2)
    expect(doc.adoptedStyleSheets[1].css).toBe('body{overflow:hidden!important}')
    s.remove()
    expect(doc.adoptedStyleSheets).toHaveLength(2)
    s.remove()
    expect(doc.adoptedStyleSheets).toEqual([other])
  })

  it('原模块确实在插 <style> 且只导出 stylesheetSingleton；vite.config 注册了插件', () => {
    const pnpm = new URL('../../../node_modules/.pnpm/', import.meta.url).pathname
    const dir = readdirSync(pnpm).find((d) => d.startsWith('react-style-singleton@'))
    expect(dir).toBeTruthy()
    const orig = readFileSync(`${pnpm}${dir}/node_modules/react-style-singleton/dist/es2015/singleton.js`, 'utf8')
    expect(orig).toMatch(/createElement\('style'\)/)
    expect(orig.match(/^export /gm)).toHaveLength(1)
    expect(orig).toMatch(/export var stylesheetSingleton/)
    expect(ADOPTED_SINGLETON).toMatch(/export var stylesheetSingleton/)
    expect(ADOPTED_SINGLETON).not.toMatch(/createElement/)
    const cfg = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
    expect(cfg).toMatch(/styleSingletonAdopted\(\)/)
  })
})
