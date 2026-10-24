import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { stripSonnerInsertCss } from './sonner-no-insert-css'

const sonnerDir = new URL('../node_modules/sonner/', import.meta.url).pathname

describe('FE-CSP-01 sonner 不在运行时插 <style>', () => {
  it('去掉 sonner 产物里的 __insertCSS 调用，函数定义保留，其余代码不变', () => {
    const src = readFileSync(sonnerDir + 'dist/index.mjs', 'utf8')
    expect(src).toMatch(/__insertCSS\("/)
    const { code, removed } = stripSonnerInsertCss(src)
    expect(removed).toBe(1)
    expect(code).not.toMatch(/__insertCSS\("/)
    expect(code).toMatch(/function __insertCSS\(/)
    expect(src.length - code.length).toBeGreaterThan(1000)
  })

  it('静态样式文件存在，并由 index.css 引入', () => {
    expect(readFileSync(sonnerDir + 'dist/styles.css', 'utf8')).toMatch(/\[data-sonner-toaster\]/)
    const css = readFileSync(new URL('../src/styles/index.css', import.meta.url), 'utf8')
    expect(css).toMatch(/@import 'sonner\/dist\/styles\.css';/)
  })

  it('vite.config 注册了插件', () => {
    const cfg = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
    expect(cfg).toMatch(/sonnerNoInsertCss\(\)/)
  })
})
