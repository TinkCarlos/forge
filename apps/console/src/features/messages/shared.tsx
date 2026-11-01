import {useMessageIdentity} from './hooks'
import { useEffect, useRef, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useCan } from '@/hooks/use-can'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
export function Field({name,label,error,children}:{name:string;label:string;error?:string;children:ReactNode}){
 const ref=useRef<HTMLDivElement>(null)
 useEffect(()=>{const control=ref.current?.querySelector<HTMLElement>(`[id="message-${name}"]`);if(control){control.setAttribute('aria-invalid',String(!!error));if(error)control.setAttribute('aria-describedby',`message-${name}-error`);else control.removeAttribute('aria-describedby')}},[name,error])
 return <div ref={ref} className='space-y-2' data-message-field={name}><Label htmlFor={`message-${name}`}>{label}</Label>{children}{error&&<p id={`message-${name}-error`} role='alert' className='text-sm text-destructive'>{error}</p>}</div>}
export function OrgField({value,onChange}:{value:string;onChange:(value:string)=>void}){
 const canView=useCan('org.view'),identity=useMessageIdentity(),query=useQuery({queryKey:['message-orgs',identity],queryFn:()=>api<{items:{id:string;name:string;status:string}[]}>('/admin/api/org-units'),enabled:canView})
 return <Field name='orgUnitId' label='组织'><Select value={value} onValueChange={onChange}><SelectTrigger id='message-orgUnitId'><SelectValue/></SelectTrigger><SelectContent><SelectItem value='current'>当前组织</SelectItem><SelectItem value='none'>未分配组织</SelectItem>{query.data?.items.filter(item=>item.status==='active').map(item=><SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>{query.isError&&<p role='alert'>组织加载失败</p>}</Field>
}
export function Pager({cursor,nextCursor,onChange}:{cursor?:string;nextCursor?:string|null;onChange:(cursor:string)=>void}){return <div className='flex justify-end gap-2'>{cursor&&<Button variant='outline' onClick={()=>onChange('')}>返回首页</Button>}<Button variant='outline' disabled={!nextCursor} onClick={()=>onChange(nextCursor!)}>下一页</Button></div>}
