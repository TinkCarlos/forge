import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * P2：新控制台所有用 id 拼出的 API 路径先校验 id（与旧版同一规则），不合法抛中文错误、不发请求。
 */
const VALID = ['01J00000000000000000000006', 'agt_01M5PK6G1GPZ3APBN3QNXR', 'apr_01M5PK6G1GPZ3APBN3QNXR']
const INVALID: unknown[] = ['../users', '..%2Fusers', '..%2F..%2F', '..', '.', '', '?x', '#x', '<img src=x onerror=alert(1)>', 'A'.repeat(5000),
  'ag_1', '01J0000000000000000000000O', 'AGT_01M5PK6G1GPZ3APBN3QNXR', 'agt_01M5PK6G1GPZ3APBN3QNX', null, undefined, 123]

const load = async () => (await import('./entity-id')) as { isEntityId(v: unknown): boolean; idSeg(v: unknown): string }

describe('P2 新控制台 id 校验 + 路径段', () => {
  it.each(VALID)('合法 id %s 通过，idSeg 原样返回', async (id) => {
    const m = await load()
    expect(m.isEntityId(id)).toBe(true)
    expect(m.idSeg(id)).toBe(id)
  })

  it.each(INVALID.map((v) => [typeof v === 'string' && v.length > 60 ? `超长(${v.length})` : String(v), v]))('非法 id %s：isEntityId=false，idSeg 抛「ID 格式无效」', async (_l, v) => {
    const m = await load()
    expect(m.isEntityId(v)).toBe(false)
    expect(() => m.idSeg(v)).toThrow(/ID 格式无效/)
  })

  it('src 里所有 /admin/api/ 模板路径（问号之前）的插值都包在 idSeg() 里', () => {
    const root = new URL('../', import.meta.url).pathname.replace(/\/$/, '')
    const bad: string[] = []
    let count = 0
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = `${dir}/${name}`
        if (statSync(p).isDirectory()) { if (name !== 'routeTree.gen.ts') walk(p) }
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          for (const t of readFileSync(p, 'utf8').match(/`\/admin\/api\/[^`]*`/g) ?? []) {
            const path = t.split('?')[0]
            for (const m of path.matchAll(/\$\{([^}]*)\}/g)) {
              count++
              if (!/^idSeg\(/.test(m[1])) bad.push(`${p.slice(root.length)}: ${t}`)
            }
          }
        }
      }
    }
    walk(root)
    expect(count).toBeGreaterThanOrEqual(4)
    expect(bad).toEqual([])
  })
})

/**
 * K-33：id 规则只有一份，在 packages/core/src/ids.ts。新控制台直接引用（vite / vitest alias + tsconfig paths
 * 把 @forge/core/ids 指到源码，不改 package.json / lockfile）；旧版 public/app.js 不经过打包，只能抄一份，
 * 这里钉住它和 ID_PATTERN_SOURCE 一字不差。
 */
describe('K-33 id 规则引用 @forge/core', () => {
  const core = () => import('@forge/core/ids') as Promise<{ ID_PATTERN: RegExp; ID_PATTERN_SOURCE: string }>

  it('entity-id 用的就是 @forge/core 的 ID_PATTERN（同一个对象），源串等于 ID_PATTERN_SOURCE', async () => {
    const { ID_PATTERN, ID_PATTERN_SOURCE } = await core()
    const m = (await import('./entity-id')) as unknown as { ENTITY_ID_PATTERN: RegExp; ENTITY_ID_PATTERN_SOURCE: string }
    expect(m.ENTITY_ID_PATTERN).toBe(ID_PATTERN)
    expect(m.ENTITY_ID_PATTERN_SOURCE).toBe(ID_PATTERN_SOURCE)
  })

  it('entity-id.ts 里不再有自己抄的正则', () => {
    const src = readFileSync(new URL('./entity-id.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/0-9A-HJKMNP-TV-Z/)
    expect(src).toMatch(/from '@forge\/core\/ids'/)
  })

  it('旧版 public/app.js 的 isEntityId 正则源串与 ID_PATTERN_SOURCE 一字不差，且只有这一处', async () => {
    const { ID_PATTERN_SOURCE } = await core()
    const legacy = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
    const literals = [...legacy.matchAll(/\/(\^\(\?:\[0-9A-HJKMNP-TV-Z\][^/]*)\/\.test\(/g)].map((m) => m[1])
    expect(literals).toEqual([ID_PATTERN_SOURCE])
  })
})
