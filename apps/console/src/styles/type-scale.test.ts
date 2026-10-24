import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// UI-056 / K-15 / FE-N08：字号只用 12/13/14/16/20/28，字重只用 400/500/600（DESIGN.md）。
// 扫业务代码的 className；components/ui/* 是 shadcn 默认，不在这里判。
const SRC = join(import.meta.dirname, '..')
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'ui' && dir.endsWith('components') ? [] : files(p)
    return p.endsWith('.tsx') ? [p] : []
  })
const BAD = /\b(text-(lg|3xl|4xl|5xl|6xl|7xl|8xl|9xl|\[[\d.]+(px|rem)\])|font-(bold|extrabold|black))(?![\w-])/g

const scan = (list: string[]) =>
  list.flatMap((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .flatMap((line, i) => [...line.matchAll(BAD)].map((m) => `${relative(SRC, f)}:${i + 1} ${m[0]}`))
  )

describe('字号字重规范', () => {
  it('K-15：登录标题和页面 H1 在规范内', () => {
    expect(scan(['features/auth/sign-in/index.tsx', 'components/layout/page-shell.tsx'].map((f) => join(SRC, f)))).toEqual([])
  })
  it('业务代码不用规范外的字号和字重', () => {
    const hits = files(SRC).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => [...line.matchAll(BAD)].map((m) => `${relative(SRC, f)}:${i + 1} ${m[0]}`))
    )
    expect(hits).toEqual([])
  })
  it('text-2xl 按设计是 28px', () => {
    const theme = readFileSync(join(SRC, 'styles/theme.css'), 'utf8')
    expect(theme).toMatch(/--text-2xl:\s*1\.75rem/)
  })
})
