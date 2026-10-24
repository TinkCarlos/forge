import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// FE-N10：禁用控件需要 not-allowed 光标，且规则必须在 @layer 之外，才能压过 disabled:pointer-events-none。
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function unlayered(src: string): string {
  let out = ''
  let depth = 0
  let inLayer = false
  let layerDepth = 0
  for (let i = 0; i < src.length; i++) {
    if (src.startsWith('@layer', i) && depth === 0) {
      inLayer = true
      layerDepth = 0
    }
    const c = src[i]
    if (c === '{') {
      depth++
      if (inLayer) layerDepth++
    } else if (c === '}') {
      depth--
      if (inLayer && --layerDepth === 0) {
        inLayer = false
        continue
      }
    }
    if (!inLayer) out += c
  }
  return out
}

describe('FE-N10 disabled cursor', () => {
  it('unlayered rule gives disabled form controls cursor:not-allowed and re-enables pointer events', () => {
    const top = unlayered(css)
    const m = /:is\(button, input, select, textarea\):disabled\s*\{([^}]*)\}/.exec(top)
    expect(m, 'rule must exist outside @layer').not.toBeNull()
    expect(m![1]).toMatch(/cursor:\s*not-allowed/)
    expect(m![1]).toMatch(/pointer-events:\s*auto/)
  })
})
