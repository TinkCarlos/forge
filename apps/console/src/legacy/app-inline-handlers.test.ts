import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * FE-XSS-01：旧控制台 public/app.js 的内联事件处理器（on*="..."）里不能拼用户可控字符串。
 * esc() 把 ' 转成 &#39;，但浏览器解析属性时会解码回 '，所以 onclick="f('${esc(name)}')" 仍可注入。
 * 只允许服务端生成的 id、静态值和布尔表达式。
 */
const src = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')

/** 取出所有 on*="..." 属性里的 ${...} 插值表达式。属性值按模板字符串扫描：${...} 里的引号和花括号不算属性结束。 */
export function inlineHandlerInterpolations(code: string): { line: number; attr: string; expr: string }[] {
  const out: { line: number; attr: string; expr: string }[] = []
  const attrRe = /\s(on[a-z]+)="/g
  for (let m = attrRe.exec(code); m; m = attrRe.exec(code)) {
    const line = code.slice(0, m.index).split('\n').length
    let i = m.index + m[0].length
    while (i < code.length && code[i] !== '"' && code[i] !== '\n') {
      if (code.startsWith('${', i)) {
        let depth = 0
        let j = i + 2
        for (; j < code.length; j++) {
          if (code[j] === '{') depth++
          else if (code[j] === '}') {
            if (depth === 0) break
            depth--
          }
        }
        out.push({ line, attr: m[1], expr: code.slice(i + 2, j).trim() })
        i = j + 1
      } else i++
    }
  }
  return out
}

// 允许：esc(x.id) / esc(x.run_id) / esc(item.id)（item 是静态导航表）以及只产出 true/false 的三元。
const ALLOWED = [
  /^esc\(\w+\.(id|run_id)\)$/,
  /^item\.id$/,
  /^[\w.?]+ \? "(true|false)" : "(true|false)"$/,
]

describe('FE-XSS-01 旧版 app.js 内联处理器', () => {
  const found = inlineHandlerInterpolations(src)

  it('能找到内联处理器插值（防止解析器失效后测试空转）', () => {
    expect(found.length).toBeGreaterThan(10)
  })

  it('on*= 属性里只插值 id / run_id / 静态值 / 布尔，不出现 name、description、key 等用户可控字段', () => {
    const bad = found.filter((f) => !ALLOWED.some((re) => re.test(f.expr)))
    expect(bad).toEqual([])
  })

  it('试运行/新版本按钮不用内联处理器，改用 data-action + data-agent-id 委托', () => {
    expect(src).not.toMatch(/onclick="app\.openAgent(Run|NewVersion)\(/)
    expect(src).toMatch(/data-action="agent-run" data-agent-id="\$\{esc\(agent\.id\)\}"/)
    expect(src).toMatch(/data-action="agent-new-version" data-agent-id="\$\{esc\(agent\.id\)\}"/)
  })
})
