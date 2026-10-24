import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * richColors toast 的文字 / 背景对比度（WCAG AA 4.5:1）。
 * 背景和默认文字取 sonner 自带样式；我们在 styles/index.css 里对 [data-sonner-toast] 覆盖的 --*-text 优先。
 * 实测（axe，3197）：浅色 success 默认 hsl(140,100%,27%) 叠 hsl(143,85%,96%) 只有 4.25:1。
 */
const sonnerCss = readFileSync(new URL('../../node_modules/sonner/dist/styles.css', import.meta.url), 'utf8')
const ourCss = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')
const themeCss = readFileSync(new URL('../styles/theme.css', import.meta.url), 'utf8')

type RGB = [number, number, number]
const hsl = (h: number, s: number, l: number): RGB => {
  s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0), f(8), f(4)].map((v) => v * 255) as RGB
}
const oklch = (L: number, C: number, H: number): RGB => {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180)
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_]
  return lin.map((v) => 255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))) as RGB
}
function themeVar(name: string, theme: 'light' | 'dark'): string {
  const block = theme === 'light' ? themeCss.slice(themeCss.indexOf(':root'), themeCss.indexOf('.dark')) : themeCss.slice(themeCss.indexOf('.dark'))
  const m = block.match(new RegExp(`${name}:\\s*([^;]+);`))
  if (!m) throw new Error(`${name} not in theme.css (${theme})`)
  return m[1].trim()
}
function parse(value: string, theme: 'light' | 'dark'): RGB {
  const v = value.trim()
  const ref = v.match(/^var\((--[\w-]+)\)$/)
  if (ref) return parse(themeVar(ref[1], theme), theme)
  let m = v.match(/^hsl\(\s*([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\s*\)$/)
  if (m) return hsl(+m[1], +m[2], +m[3])
  m = v.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/)
  if (m) return oklch(+m[1], +m[2], +m[3])
  m = v.match(/^#([0-9a-f]{6})$/i)
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB
  throw new Error(`unsupported colour ${v}`)
}
const lum = (c: RGB) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
const ratio = (a: RGB, b: RGB) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }

/** 取 css 里某个选择器块中的自定义属性。 */
function vars(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  let i = css.indexOf(selector)
  while (i !== -1) {
    const start = css.indexOf('{', i), end = css.indexOf('}', start)
    for (const m of css.slice(start + 1, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
    i = css.indexOf(selector, end)
  }
  return out
}

describe.each(['light', 'dark'] as const)('richColors toast 对比度（%s）', (theme) => {
  const sonner = vars(sonnerCss, `[data-sonner-toaster][data-sonner-theme='${theme}'] {`)
  const ours = vars(ourCss, `[data-sonner-toaster][data-sonner-theme='${theme}'] [data-sonner-toast] {`)
  it.each(['success', 'info', 'warning', 'error'])('%s 文字 ≥ 4.5:1', (type) => {
    const bg = parse(sonner[`--${type}-bg`], theme)
    const text = parse(ours[`--${type}-text`] ?? sonner[`--${type}-text`], theme)
    expect(ratio(text, bg)).toBeGreaterThanOrEqual(4.5)
  })
})
