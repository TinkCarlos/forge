import { handleServerError } from '@/lib/handle-server-error'
import { Route } from '@/routes/_authenticated/messages/'
import { PageShell } from '@/components/layout/page-shell'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Channels } from './channels'
import { Templates } from './templates'
import { Rules } from './rules'
import { Deliveries } from './deliveries'
import { statusNames } from './hooks'
export function Messages(){
 const search=Route.useSearch(),navigate=Route.useNavigate(),onCursor=(cursor:string)=>{(navigate({search:previous=>({...previous,cursor})})).catch(handleServerError)}
 const delivery=search.tab==='deliveries',statuses=delivery?['queued','sending','retry_wait','delivered','failed','unknown','held','cancelled']:['active','disabled']
 return <PageShell title='消息管理'><Tabs value={search.tab} onValueChange={tab=>{(navigate({search:previous=>({...previous,tab:tab as typeof search.tab,status:'',cursor:''})})).catch(handleServerError)}} className='space-y-4'><TabsList className='h-auto flex-wrap justify-start'><TabsTrigger value='channels'>渠道配置</TabsTrigger><TabsTrigger value='rules'>消息规则</TabsTrigger><TabsTrigger value='templates'>消息模板</TabsTrigger><TabsTrigger value='deliveries'>发送记录</TabsTrigger></TabsList>
 <div className='flex flex-wrap items-center gap-3'><Label htmlFor='messages-status'>状态</Label><Select value={search.status||'all'} onValueChange={value=>{(navigate({search:previous=>({...previous,status:value==='all'?'':value,cursor:''})})).catch(handleServerError)}}><SelectTrigger id='messages-status' className='w-36'><SelectValue/></SelectTrigger><SelectContent><SelectItem value='all'>全部</SelectItem>{statuses.map(value=><SelectItem key={value} value={value}>{statusNames[value]}</SelectItem>)}</SelectContent></Select></div>
 {delivery&&<form className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4' onSubmit={event=>event.preventDefault()}>{(['channelId','eventType','sourceType','sourceId'] as const).map(key=><div key={key} className='space-y-2'><Label htmlFor={`filter-${key}`}>{{channelId:'渠道 ID',eventType:'事件类型',sourceType:'来源类型',sourceId:'来源 ID'}[key]}</Label><Input id={`filter-${key}`} defaultValue={search[key]} key={search[key]} onBlur={event=>{const value=event.target.value;if(value!==search[key])(navigate({search:previous=>({...previous,[key]:value,cursor:''})})).catch(handleServerError)}}/></div>)}{(['from','to'] as const).map(key=><div key={key} className='space-y-2'><Label htmlFor={`filter-${key}`}>{key==='from'?'开始时间':'结束时间'}</Label><Input type='datetime-local' id={`filter-${key}`} key={search[key]} defaultValue={search[key]?new Date(new Date(search[key]).getTime()-new Date(search[key]).getTimezoneOffset()*60000).toISOString().slice(0,16):''} onBlur={event=>{const value=event.target.value?new Date(event.target.value).toISOString():'';if(value!==search[key])(navigate({search:previous=>({...previous,[key]:value,cursor:''})})).catch(handleServerError)}}/></div>)}</form>}
 <TabsContent value='channels'><Channels status={search.status} cursor={search.cursor} onCursor={onCursor}/></TabsContent><TabsContent value='rules'><Rules status={search.status} cursor={search.cursor} onCursor={onCursor}/></TabsContent><TabsContent value='templates'><Templates status={search.status} cursor={search.cursor} onCursor={onCursor}/></TabsContent><TabsContent value='deliveries'><Deliveries filters={{status:search.status,cursor:search.cursor,channelId:search.channelId,eventType:search.eventType,sourceType:search.sourceType,sourceId:search.sourceId,from:search.from,to:search.to}} onCursor={onCursor}/></TabsContent>
 </Tabs></PageShell>
}
