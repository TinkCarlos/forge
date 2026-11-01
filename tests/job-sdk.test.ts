import {expect,it} from 'vitest';
import {createJobClient} from '../packages/sdk/src/job-client.js';
it('carries business and organization filters while dropping unrelated browser state',async()=>{
 const paths:string[]=[],client=createJobClient(async<T>(path:string)=>{paths.push(path);return {} as T;});
 await client.list({businessType:'月度报告',orgUnitId:'01J00000000000000000000000',status:'active',...{tab:'other'}});
 const url=new URL(paths[0]!,'http://local.test');expect(Object.fromEntries(url.searchParams)).toEqual({businessType:'月度报告',orgUnitId:'01J00000000000000000000000',status:'active'});
});

it('accepts the HTTP input contract with defaults omitted for create and draft update',async()=>{
 const {JOB_CREATE_SCHEMA}=await import('@forge/contracts');
 const calls:unknown[]=[],client=createJobClient(async<T>(_path:string,options?:{body?:unknown})=>{calls.push(options?.body);return{} as T;});
 const draft={schemaVersion:1 as const,target:{kind:'agent' as const,key:'technical',version:'01J00000000000000000000000',checksum:'a'.repeat(64)},inputSchema:{type:'object'},outputSchema:{},nodes:[]};
 const body={key:'minimal-sdk',name:'最小请求',businessType:'technical',draft};expect(JOB_CREATE_SCHEMA.safeParse(body).success).toBe(true);
 await client.create(body);await client.update('01J00000000000000000000000',1,{draft});expect(calls).toEqual([body,{draft}]);
});
