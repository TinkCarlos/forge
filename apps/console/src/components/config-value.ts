export type ConfigValue = null | string | number | boolean | ConfigValue[] | { [key: string]: ConfigValue }

export function renameConfigField(value: { [key: string]: ConfigValue }, previous: string, next: string) {
  if (!next.trim() || ['__proto__', 'constructor', 'prototype'].includes(next)) throw new Error('请输入有效的字段标识')
  if (previous !== next && Object.hasOwn(value, next)) throw new Error('字段标识不能重复')
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key === previous ? next : key, item]))
}
