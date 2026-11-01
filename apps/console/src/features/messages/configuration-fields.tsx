import { useInfiniteQuery } from '@tanstack/react-query'
import { useCan } from '@/hooks/use-can'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useMessageIdentity } from './hooks'

import type { HeaderRow } from './configuration-values'
import { handleServerError } from '@/lib/handle-server-error'

export function SecretPicker({ value, onChange, id, label }: { value: string; onChange: (value: string) => void; id?: string; label: string }) {
  const allowed = useCan('secret.manage'), identity = useMessageIdentity()
  const query = useInfiniteQuery({ queryKey: ['message-secret-options', identity], enabled: allowed, initialPageParam: '', queryFn: ({ pageParam }) => api<{ items: { id: string; name: string; key: string; status: string }[]; nextCursor?: string | null }>(`/admin/api/secrets?limit=200${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`), getNextPageParam: page => page.nextCursor ?? undefined })
  const items = query.data?.pages.flatMap(page => page.items) ?? []
  return <div className='min-w-0 flex-1 space-y-2'><Select value={value} onValueChange={onChange} disabled={!allowed || query.isPending}><SelectTrigger id={id} aria-label={label} className='w-full min-w-0 [&>span]:min-w-0 [&>span]:truncate'><SelectValue placeholder={allowed ? '选择凭据' : '需要凭据管理权限'} /></SelectTrigger><SelectContent>{value && !items.some(item => item.id === value) && <SelectItem value={value}>当前选中的凭据</SelectItem>}{items.filter(item => item.status === 'active').map(item => <SelectItem key={item.id} value={item.id}>{item.name} · {item.key}</SelectItem>)}</SelectContent></Select>{query.isError && <p role='alert' className='text-sm text-destructive'>凭据加载失败 <Button type='button' variant='link' onClick={() => { query.refetch().catch(handleServerError) }}>重试</Button></p>}{query.hasNextPage && <Button type='button' variant='link' disabled={query.isFetchingNextPage} onClick={() => { query.fetchNextPage().catch(handleServerError) }}>加载更多凭据</Button>}</div>
}

export function HeaderFields({ rows, onChange, fieldId }: { rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void; fieldId?: string }) {
  return <div className='space-y-3'>{rows.map((row, index) => <div key={row.id} className='grid items-start gap-2 sm:grid-cols-[1fr_1fr_auto]'><Input id={index===0?fieldId:undefined} aria-label={`第 ${index + 1} 个请求头名称`} placeholder='例如：Authorization' value={row.name} required onChange={event => onChange(rows.map(item => item.id === row.id ? { ...item, name: event.target.value } : item))} /><SecretPicker value={row.secretId} label={`第 ${index + 1} 个请求头凭据`} onChange={secretId => onChange(rows.map(item => item.id === row.id ? { ...item, secretId } : item))} /><Button type='button' variant='ghost' aria-label={`删除第 ${index + 1} 个请求头`} onClick={() => onChange(rows.filter(item => item.id !== row.id))}>删除</Button></div>)}<Button id={rows.length===0?fieldId:undefined} type='button' variant='outline' size='sm' onClick={() => onChange([...rows, { id: crypto.randomUUID(), name: '', secretId: '' }])}>添加请求头</Button></div>
}

export function MemberFields({ value, onChange, label, phone = false }: { value: string[]; onChange: (value: string[]) => void; label: string; phone?: boolean }) {
  const id = phone ? 'message-mentionedMobiles' : 'message-mentionedIds'
  return <div className='space-y-2'>{value.map((item, index) => <div key={index} className='flex gap-2'><Input id={index===0?id:undefined} type={phone ? 'tel' : 'text'} aria-label={`${label} ${index + 1}`} value={item} required onChange={event => onChange(value.map((entry, position) => position === index ? event.target.value : entry))} /><Button type='button' variant='ghost' aria-label={`删除${label} ${index + 1}`} onClick={() => onChange(value.filter((_, position) => position !== index))}>删除</Button></div>)}<Button id={value.length===0?id:undefined} type='button' variant='outline' size='sm' onClick={() => onChange([...value, ''])}>添加{label}</Button></div>
}
