import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

import { renameConfigField, type ConfigValue } from './config-value'
const types = { string: '文本', number: '数字', boolean: '是／否', object: '字段组', array: '列表', null: '空值' }
const defaults: Record<keyof typeof types, ConfigValue> = { string: '', number: 0, boolean: false, object: {}, array: [], null: null }
const labels: Record<string, string> = { inputSchema: '输入字段', outputSchema: '输出字段', nodes: '执行步骤', outcomeNodeKey: '结果步骤标识', type: '数据类型', properties: '字段定义', required: '必填字段', description: '说明', title: '显示名称', items: '列表项', additionalProperties: '允许其他字段', key: '标识', kind: '步骤类型', dependsOn: '依赖步骤', target: '执行目标', condition: '执行条件', inputMapping: '输入映射', timeoutSeconds: '超时（秒）', maxAttempts: '最多尝试次数', maxIterations: '最多循环次数', ref: '引用路径', literal: '固定值', object: '字段组', array: '列表', op: '比较方式', left: '左侧值', right: '右侧值', args: '条件列表', arg: '条件', enum: '可选值', minimum: '最小值', maximum: '最大值', default: '默认值' }

export function StructuredValueEditor({ value, onChange, label, disabled = false, depth = 0 }: { value: ConfigValue; onChange: (value: ConfigValue) => void; label: string; disabled?: boolean; depth?: number }) {
  const id = useId(), [error, setError] = useState('')
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value as keyof typeof types
  const container = type === 'object' || type === 'array'
  return <fieldset disabled={disabled} className='min-w-0 space-y-2'>
    <div className='flex flex-wrap items-center gap-2'><Label htmlFor={id} className='flex-1 break-words'>{label}</Label><Select value={type} onValueChange={next => onChange(structuredClone(defaults[next as keyof typeof defaults]))}><SelectTrigger aria-label={`${label}的数据格式`} className='w-28'><SelectValue /></SelectTrigger><SelectContent>{Object.entries(types).map(([key, name]) => <SelectItem key={key} value={key}>{name}</SelectItem>)}</SelectContent></Select></div>
    {type === 'string' && <Textarea id={id} rows={2} value={String(value)} onChange={event => onChange(event.target.value)} />}
    {type === 'number' && <Input id={id} type='number' step='any' required value={String(value)} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) onChange(event.target.valueAsNumber) }} />}
    {type === 'boolean' && <Select value={String(value)} onValueChange={next => onChange(next === 'true')}><SelectTrigger id={id}><SelectValue /></SelectTrigger><SelectContent><SelectItem value='true'>是</SelectItem><SelectItem value='false'>否</SelectItem></SelectContent></Select>}
    {container && <div id={id} className='space-y-4 border-s ps-3'>
      {depth >= 64 ? <p className='text-sm text-muted-foreground'>此处嵌套较深，现有内容将完整保留。</p> : Object.entries(value as object).map(([key, item]) => <div key={key} className='min-w-0 space-y-2'>
        <div className='flex items-center gap-2'>{type === 'object' && <Input aria-label={`${label}的字段标识 ${key}`} defaultValue={key} onBlur={event => { try { onChange(renameConfigField(value as { [key: string]: ConfigValue }, key, event.target.value)); setError('') } catch (err) { setError((err as Error).message); event.target.value = key } }} />}<Button type='button' variant='ghost' size='sm' aria-label={`删除${labels[key] ?? key}`} onClick={() => onChange(Array.isArray(value) ? value.filter((_, index) => String(index) !== key) : Object.fromEntries(Object.entries(value as object).filter(([name]) => name !== key)))}>删除</Button></div>
        <StructuredValueEditor label={Array.isArray(value) ? `第 ${Number(key) + 1} 项` : labels[key] ?? key} value={item as ConfigValue} depth={depth + 1} onChange={next => onChange(Array.isArray(value) ? value.map((entry, index) => String(index) === key ? next : entry) : { ...value as object, [key]: next })} />
      </div>)}
      {depth < 64 && <Button type='button' variant='outline' size='sm' onClick={() => { if (Array.isArray(value)) onChange([...value, '']); else { const object = value as { [key: string]: ConfigValue }; let key = 'field'; for (let i = 1; Object.hasOwn(object, key); i++) key = `field${i}`; onChange({ ...object, [key]: '' }) } }}>{Array.isArray(value) ? '添加一项' : '添加字段'}</Button>}
    </div>}
    {error && <p role='alert' className='text-sm text-destructive'>{error}</p>}
  </fieldset>
}
