import type {QueryClient} from '@tanstack/react-query'
import {useEffect,useState,useRef} from 'react'
import {createMessageClient} from '@forge/sdk/messages'
import {api,ApiError} from '@/lib/api'
import {useAuthStore} from '@/stores/auth-store'
import {jobCacheIdentity} from '@/features/jobs/cache-identity'
export const messageClient=createMessageClient(api)
export function useMessageIdentity(){return useAuthStore(state=>jobCacheIdentity(state.session))}
export function useEditorState(){
 const latch=useRef(false)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[fields,setFields]=useState<Record<string,string>>({})
 useEffect(()=>{if(!busy){const name=Object.keys(fields)[0];if(name){const control=document.querySelector<HTMLElement>(`[data-message-field="${name}"] input,[data-message-field="${name}"] textarea,[data-message-field="${name}"] button`);control?.closest('details')?.setAttribute('open','');control?.focus()}}},[busy,fields])
 return{busy,error,fields,async save(fn:()=>Promise<unknown>,done:()=>void){if(latch.current)return;latch.current=true;setBusy(true);setError('');setFields({});try{await fn();done()}catch(err){setError(err instanceof Error?err.message:'保存失败');if(err instanceof ApiError&&err.details?.fields)setFields(Object.fromEntries(err.details.fields.map(field=>[field.path.split('.')[0],field.issue])))}finally{latch.current=false;setBusy(false)}}}
}
export const orgValue=(value:string)=>value==='current'?undefined:value==='none'?null:value
export const statusNames:Record<string,string>={active:'已启用',disabled:'已停用',queued:'待发送',sending:'发送中',retry_wait:'等待重试',delivered:'已送达',failed:'发送失败',unknown:'结果未知',held:'已挂起',cancelled:'已取消',prepared:'已准备',submitted:'已派发',succeeded:'成功'}

export const invalidateMessages=(cache:QueryClient)=>cache.invalidateQueries({predicate:query=>String(query.queryKey[0]).startsWith("message")})
