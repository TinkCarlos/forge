import { createFileRoute } from '@tanstack/react-router'
import { Messages } from '@/features/messages'
import { RouteError } from '@/features/errors/route-error'
import { guard } from '@/lib/route-guard'
export const Route=createFileRoute('/_authenticated/messages/')({beforeLoad:guard('message.view'),errorComponent:RouteError,component:Messages,validateSearch:(input:Record<string,unknown>)=>{
 const text=(name:string)=>typeof input[name]==='string'?(input[name] as string).slice(0,2048):''
 const tab=['channels','rules','templates','deliveries'].includes(text('tab'))?text('tab') as 'channels'|'rules'|'templates'|'deliveries':'channels',statuses=tab==='deliveries'?['queued','sending','retry_wait','delivered','failed','unknown','held','cancelled']:['active','disabled']
 return{tab,status:statuses.includes(text('status'))?text('status'):'',cursor:text('cursor'),channelId:text('channelId'),eventType:text('eventType'),sourceType:text('sourceType'),sourceId:text('sourceId'),from:Number.isFinite(Date.parse(text('from')))?new Date(text('from')).toISOString():'',to:Number.isFinite(Date.parse(text('to')))?new Date(text('to')).toISOString():''}
}})
