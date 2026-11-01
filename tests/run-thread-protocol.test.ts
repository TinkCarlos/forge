import {randomBytes} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {execute,one,query,repos,withRunLease} from '@forge/store';

const ADMIN='01J00000000000000000000001', ORG='01J00000000000000000000000';
let agentId='',versionId='';
const suffix=randomBytes(8).toString('hex');
const admission=(threadId?:string|null)=>({threadId,agentId,agentVersionId:versionId,appId:null,orgUnitId:ORG,subjectType:'user',subjectId:ADMIN,triggerType:'manual',triggerRef:null,input:{text:'technical fixture'},title:'technical fixture',message:{text:'technical fixture'}});
beforeAll(async()=>{agentId=await repos.createAgent({key:'thread-protocol-'+suffix,name:'technical thread',createdBy:ADMIN});versionId=await repos.createAgentVersion({agentId,version:'1',instructions:'x',spec:{model:{provider:'mock',model:'mock-1'}},status:'published',createdBy:ADMIN},{expectedRevision:'system'});});
afterAll(async()=>{if(!agentId)return;await execute('DELETE FROM runs WHERE agent_id=?',[agentId]);await execute('DELETE FROM threads WHERE agent_id=?',[agentId]);await execute('DELETE FROM agent_versions WHERE agent_id=?',[agentId]);await execute('DELETE FROM agents WHERE id=?',[agentId]);});

describe('E1 thread admission, ordering and engine boundary',()=>{
 it('atomically creates one initial message/event and rejects concurrent admission on the same thread',async()=>{
   const threadId=await repos.createThread({agentId,orgUnitId:ORG,subjectType:'user',subjectId:ADMIN});
   const results=await Promise.allSettled([repos.admitRun(admission(threadId)),repos.admitRun(admission(threadId))]);
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
   expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'CFG-8503'}});
   const runs=await query<{id:string}>('SELECT id FROM runs WHERE thread_id=?',[threadId]);expect(runs).toHaveLength(1);
   expect(await repos.listMessages(runs[0]!.id)).toMatchObject([{seq:1,thread_seq:'1',protocol_version:'forge-legacy-1'}]);
   expect(await one('SELECT active_run_id,next_message_seq FROM threads WHERE id=?',[threadId])).toEqual({active_run_id:runs[0]!.id,next_message_seq:2});
   expect(await query('SELECT seq,type FROM run_events WHERE run_id=?',[runs[0]!.id])).toEqual([{seq:1,type:'run.queued'}]);
 });
 it('retains the active pointer through waiting and releases only its own pointer at terminal state',async()=>{
   const first=await repos.admitRun(admission());const run=await repos.getRun(first);const threadId=run!.thread_id;
   await repos.updateRun(first,{status:'waiting_approval'});await expect(repos.admitRun(admission(threadId))).rejects.toMatchObject({code:'CFG-8503'});
   await repos.updateRun(first,{status:'cancelled'});const second=await repos.admitRun(admission(threadId));
   await repos.updateRun(first,{status:'cancelled'});expect(await one('SELECT active_run_id FROM threads WHERE id=?',[threadId])).toEqual({active_run_id:second});
   const before=await repos.getThread(threadId);await expect(repos.addMessage({threadId,runId:first,seq:2,role:'assistant',content:{text:'late'}})).rejects.toMatchObject({code:'RUN-7005'});expect((await repos.getThread(threadId))?.next_message_seq).toBe(before?.next_message_seq);
   expect((await repos.listThreadMessages(threadId)).map(m=>[m.run_id,m.seq,m.thread_seq])).toEqual([[first,1,'1'],[second,1,'2']]);
 });
 it('checks subject/App identity, deletion and untracked legacy active runs without changing the thread',async()=>{
   const first=await repos.admitRun(admission());const threadId=(await repos.getRun(first))!.thread_id;await repos.updateRun(first,{status:'succeeded'});
   await expect(repos.admitRun({...admission(threadId),subjectId:'01J00000000000000000000002'})).rejects.toMatchObject({code:'RUN-7001'});
   await expect(repos.admitRun({...admission(threadId),appId:'01J00000000000000000000002'})).rejects.toMatchObject({code:'RUN-7001'});
   const legacy=await repos.createRun({...admission(threadId),threadId});await expect(repos.admitRun(admission(threadId))).rejects.toMatchObject({code:'CFG-8503'});
   await repos.updateRun(legacy,{status:'failed'});await execute('UPDATE threads SET deleted_at=UTC_TIMESTAMP(3) WHERE id=?',[threadId]);await expect(repos.admitRun(admission(threadId))).rejects.toMatchObject({code:'RUN-7001'});
 });
 it('binds a legacy App thread only when every historical Run proves the same source',async()=>{
   const appId='01J00000000000000000000092';
   const base={...admission(),appId,subjectType:'app',subjectId:appId};
   const threadId=await repos.createThread({agentId,orgUnitId:ORG,subjectType:'app',subjectId:appId});
   await repos.createRun({...base,threadId,status:'succeeded'});
   const resumed=await repos.admitRun({...base,threadId});expect((await repos.getRun(resumed))?.app_id).toBe(appId);
   expect((await repos.getThread(threadId))?.app_id).toBe(appId);
   const mixed=await repos.createThread({agentId,orgUnitId:ORG,subjectType:'app',subjectId:appId});
   await repos.createRun({...base,threadId:mixed,status:'succeeded'});await repos.createRun({...base,threadId:mixed,appId:null,status:'succeeded'});
   await expect(repos.admitRun({...base,threadId:mixed})).rejects.toMatchObject({code:'RUN-7001'});expect((await repos.getThread(mixed))?.app_id).toBeNull();
   const empty=await repos.createThread({agentId,orgUnitId:ORG,subjectType:'app',subjectId:appId});await expect(repos.admitRun({...base,threadId:empty})).rejects.toMatchObject({code:'RUN-7001'});
 });
 it('allocates exact BIGINT thread sequences concurrently and rolls back failed or stale writes',async()=>{
   const id=await repos.admitRun(admission());const threadId=(await repos.getRun(id))!.thread_id;
   await execute("UPDATE threads SET next_message_seq=9007199254740993 WHERE id=?",[threadId]);
   await Promise.all([2,3,4].map(seq=>repos.addMessage({threadId,runId:id,seq,role:'assistant',content:{seq}})));
   expect((await query<{n:string}>('SELECT CAST(thread_seq AS CHAR) AS n FROM messages WHERE run_id=? ORDER BY thread_seq',[id])).map(r=>r.n)).toEqual(['1','9007199254740993','9007199254740994','9007199254740995']);
   expect((await repos.listMessages(id)).map(m=>m.thread_seq).sort((a,b)=>BigInt(a!)<BigInt(b!)?-1:1)).toEqual(['1','9007199254740993','9007199254740994','9007199254740995']);
   expect((await repos.listThreadMessages(threadId)).map(m=>m.thread_seq)).toEqual(['1','9007199254740993','9007199254740994','9007199254740995']);
   expect((await repos.getThread(threadId))?.next_message_seq).toBe('9007199254740996');
   await expect(repos.addMessage({threadId,runId:id,seq:2,role:'assistant',content:{}})).rejects.toBeDefined();
   const before=await one('SELECT CAST(next_message_seq AS CHAR) AS n FROM threads WHERE id=?',[threadId]);
   await expect(withRunLease(id,'stale',()=>repos.addMessage({threadId,runId:id,seq:5,role:'assistant',content:{}}))).rejects.toMatchObject({name:'LeaseLostError'});
   expect(await one('SELECT CAST(next_message_seq AS CHAR) AS n FROM threads WHERE id=?',[threadId])).toEqual(before);
 });
 it('keeps historical ordering explicitly legacy and never claims another runtime engine',async()=>{
   const id=await repos.admitRun(admission());const threadId=(await repos.getRun(id))!.thread_id;
   await execute('UPDATE messages SET thread_seq=NULL,protocol_version=NULL WHERE run_id=?',[id]);
   await repos.addMessage({threadId,runId:id,seq:2,role:'assistant',content:{}});
   expect((await repos.listThreadMessages(threadId)).map(r=>[r.seq,r.thread_seq,r.protocol_version])).toEqual([[1,null,null],[2,'2','forge-legacy-1']]);
   await execute("UPDATE runs SET runtime_engine='temporal-pi' WHERE id=?",[id]);expect(await repos.claimRun(id,'legacy-worker',30,false)).toBeNull();
   await execute("UPDATE runs SET runtime_engine='mysql-pi' WHERE id=?",[id]);expect(await repos.claimRun(id,'legacy-worker',30,false)).toBeNull();
   await execute("UPDATE runs SET runtime_engine='mysql-legacy' WHERE id=?",[id]);expect((await repos.claimRun(id,'legacy-worker',30,false))?.run.id).toBe(id);
 });
});
