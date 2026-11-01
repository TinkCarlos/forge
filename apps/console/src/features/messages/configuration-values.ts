export type HeaderRow = { id: string; name: string; secretId: string }
export function headerRowsToRecord(rows: HeaderRow[]): Record<string, string> {
  const seen = new Set<string>()
  return Object.fromEntries(rows.map(row => {
    const name = row.name.trim(), lower = name.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) throw new Error('请求头名称仅支持英文、数字和 HTTP 标点')
    if (seen.has(lower)) throw new Error(`请求头 ${name} 重复，请保留一行`)
    if (!row.secretId) throw new Error(`请为请求头 ${name} 选择凭据`)
    seen.add(lower)
    return [name, row.secretId]
  }))
}
