import {QueryClient} from '@tanstack/react-query'
import {expect,it,vi} from 'vitest'
import {jobCacheIdentity} from './cache-identity'
it('cannot reuse another logged-in users fresh list or draft cache',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity,retry:false}}})
 const first=jobCacheIdentity({user:{id:'first'},permissions:['job.view','job.manage']}),second=jobCacheIdentity({user:{id:'second'},permissions:['job.view']})
 await client.fetchQuery({queryKey:['jobs',first,'',''],queryFn:async()=>[{name:'private task',draft:{secret:'business'}}]})
 const fetchSecond=vi.fn(async()=>[])
 expect(await client.fetchQuery({queryKey:['jobs',second,'',''],queryFn:fetchSecond})).toEqual([]);expect(fetchSecond).toHaveBeenCalledOnce()
 expect(jobCacheIdentity({user:{id:'first'},permissions:['job.view']})).not.toBe(first)
 client.clear()
})
