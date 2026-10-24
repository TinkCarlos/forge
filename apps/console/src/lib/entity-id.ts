/**
 * P2：拼进 API 路径的 id 先按仓库 id 格式校验——26 位，纯 ULID（seed，如 01J00000000000000000000006）或
 * 3 位小写前缀 + "_" + 22 位 ULID 字符（@forge/core ulidWithPrefix，如 agt_…）。和旧版 public/app.js 的 isEntityId 同一条规则。
 */
const ENTITY_ID = /^(?:[0-9A-HJKMNP-TV-Z]{26}|[a-z]{3}_[0-9A-HJKMNP-TV-Z]{22})$/

export function isEntityId(value: unknown): value is string {
  return typeof value === 'string' && ENTITY_ID.test(value)
}

/** 路径段用：不合法直接抛错（mutation 走 onError → 中文 toast），不发请求；合法的照旧 encodeURIComponent。 */
export function idSeg(value: unknown): string {
  if (!isEntityId(value)) throw new Error('ID 格式无效，已取消请求')
  return encodeURIComponent(value)
}
