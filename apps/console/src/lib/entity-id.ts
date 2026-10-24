import { ID_PATTERN, ID_PATTERN_SOURCE } from '@forge/core/ids'

/**
 * P2：拼进 API 路径的 id 先按仓库 id 格式校验——26 位，纯 ULID（seed，如 01J00000000000000000000006）或
 * 3 位小写前缀 + "_" + 22 位 ULID 字符（@forge/core ulidWithPrefix，如 agt_…）。
 * K-33：规则只有一份，直接引用 packages/core/src/ids.ts；旧版 public/app.js 的 isEntityId 抄的是同一个源串
 * （entity-id.test.ts 钉住一字不差）。
 */
export const ENTITY_ID_PATTERN = ID_PATTERN
export const ENTITY_ID_PATTERN_SOURCE = ID_PATTERN_SOURCE

export function isEntityId(value: unknown): value is string {
  return typeof value === 'string' && ENTITY_ID_PATTERN.test(value)
}

/** 路径段用：不合法直接抛错（mutation 走 onError → 中文 toast），不发请求；合法的照旧 encodeURIComponent。 */
export function idSeg(value: unknown): string {
  if (!isEntityId(value)) throw new Error('ID 格式无效，已取消请求')
  return encodeURIComponent(value)
}
