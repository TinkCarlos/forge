import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
function fn(name: string) { const m = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm')); if (!m) throw Error(name); return m[0] }
function method(name: string) { const m = source.match(new RegExp(`^  (?:async )?${name}\\([^)]*\\) \\{[\\s\\S]*?^  \\},?$`, 'm')); if (!m) throw Error(name); return m[0].replace(/,$/,'') }

describe('账号编辑保留空部门和版本，密码单独修改', () => {
  it('unassigned account stays unassigned when only display name changes', async () => {
    const current = { id: 'usr_01M6AAAAAAAAAAAAAAAAAA', revision: 7, username: 'sso-only', email: 'a@forge.local', display_name: 'Before', org_unit_id: null, role: 'user', data_scope: 'self', status: 'active' }
    const calls: Array<{ path: string; opts?: { body?: unknown; headers?: unknown } }> = []
    let body = '', submit: ((form: FormData) => Promise<void>) | undefined
    const state = { tab:"users", session: { user: { id: 'admin', role: 'platform_admin', orgUnitId: 'root' }, permissions: ['*'] }, grantableRoles: ['user'] }
    const api = async (path: string, opts?: { body?: unknown; headers?: unknown }) => { calls.push({ path, opts }); return path === '/admin/api/org-units' ? { items: [{ id: 'root', name: '根部门', status: 'active' }] } : current }
    const deps = { bindRoleFields:()=>{}, state, api, openModal: (_title: string, html: string, callback: typeof submit) => { body = html; submit = callback }, ROLE_LABELS: {}, SCOPE_LABELS: { self: '本人' }, idSeg: (id: string) => id, toast: () => {}, renderUsers: async () => {} }
    const app = new Function(...Object.keys(deps), `${['esc','field','select','revisionHeaders','additionalRolesField'].map(fn).join('\n')}\nreturn {${method('openUser')}}`)(...Object.values(deps)) as {openUser(id:string):Promise<void>}
    await app.openUser(current.id)
    expect(body).toMatch(/<option value="" selected>未分配<\/option>/)
    expect(body).not.toContain('data-credential-input')
    const form = new FormData()
    for (const [key, value] of Object.entries({ username:'sso-only', email:'a@forge.local', displayName:'After', role:'user', dataScope:'self', status:'active', orgUnitId:'' })) form.set(key,value)
    await submit!(form)
    expect(calls.at(-1)?.opts).toMatchObject({ headers: { 'If-Match':'"7"' }, body: { displayName:'After',orgUnitId:null } })
  })
})

describe('账号和日志分页的失败恢复', () => {
  it('failed next + retry + previous returns to first page and ignores double clicks', async () => {
    const buttons = [{ dataset:{page:'previous'}, disabled:true, onclick:async()=>{} },{ dataset:{page:'next'},disabled:false,onclick:async()=>{} }]
    const state = { userRequest:0, userFilters:{cursor:'',history:[] as string[]} }
    const errors: string[] = []
    const bind = new Function('state','$','toast','errorText',`${fn('bindPagination')}\nreturn bindPagination`)(state,()=>({querySelectorAll:()=>buttons}),(e:string)=>errors.push(e),(e:Error)=>e.message) as (kind:string,result:{nextCursor:string|null},render:()=>Promise<void>)=>void
    bind('user',{nextCursor:'second'},async()=>{state.userRequest++;throw Error('offline')})
    await buttons[1]!.onclick()
    expect(state.userFilters).toEqual({cursor:'',history:[]})
    expect(errors).toEqual(['offline'])
    let release: (()=>void) | undefined
    let renders = 0
    bind('user',{nextCursor:'second'},async()=>{state.userRequest++;renders++;await new Promise<void>(resolve=>{release=resolve})})
    const first = buttons[1]!.onclick()
    await buttons[1]!.onclick()
    expect(renders).toBe(1)
    release!();await first
    expect(state.userFilters).toEqual({cursor:'second',history:['']})
    bind('user',{nextCursor:'third'},async()=>{state.userRequest++})
    await buttons[0]!.onclick()
    expect(state.userFilters).toEqual({cursor:'',history:[]})
  })
})

it('late list response cannot replace a newer search result', async () => {
  const content = {innerHTML:'',querySelectorAll:()=>[]}; const form = {onsubmit:null};
  const state = {tab:"users",session:{permissions:['user.view'],user:{role:'user'}},userFilters:{q:'old',status:'',cursor:'',history:[]},users:[]};
  const resolves: Array<(value:unknown)=>void> = [];
  const api = async()=>new Promise(resolve=>resolves.push(resolve));
  const helpers=['esc','statusPill','canPermission','accountTabs','listQuery','renderUsers'].map(fn).join('\n');
  const render = new Function('api','state','$','ROLE_LABELS','SCOPE_LABELS','select','pagination','bindPagination',helpers+'\nreturn renderUsers')(api,state,(s:string)=>s==='#content'?content:form,{},{},()=>'',()=>'',()=>{}) as ()=>Promise<void>;
  const old = render();state.userFilters.q='new';const current=render();
  const result=(name:string)=>({items:[{id:name,username:name,display_name:name,email:'a@forge.local',role:'user',data_scope:'self',status:'active',can_manage:false}],grantableRoles:[],canCreate:false,nextCursor:null});
  resolves[1]!(result('new'));await current;resolves[0]!(result('old'));await old;
  expect(content.innerHTML).toContain('value="new"');expect(content.innerHTML).not.toContain('>old<');expect(state.users).toMatchObject([{username:'new'}]);
});

it('after login chooses an allowed page and preserves an authorized agent deep link', () => {
  const groups=[{items:[{id:'users',permission:'user.view'},{id:'agents',permission:'agent.view'}]}];
  const route = new Function('navGroups','canPermission',fn('navAllowed')+'\n'+fn('routeAfterLogin')+'\nreturn routeAfterLogin')(groups,(p:string)=>p==='agent.view') as (route:string)=>string;
  expect(route('users')).toBe('agents');expect(route('agents/known-agent')).toBe('agents/known-agent');
});

it('delete and session revocation stay inside the pending confirmation callback', async () => {
  const calls:Array<{path:string;options?:unknown}>=[]
  let confirm: (()=>Promise<void>) | undefined
  const row={id:'target',username:'target',revision:8}
  const deps={bindRoleFields:()=>{},state:{session:{user:{id:'actor'}}},api:async(path:string,options?:unknown)=>{calls.push({path,options});return row},idSeg:(id:string)=>id,openModal:(_title:string,_body:string,callback:()=>Promise<void>)=>{confirm=callback},toast:()=>{},renderUsers:async()=>{}}
  const app=new Function(...Object.keys(deps),[fn('esc'),fn('revisionHeaders'),`return {${method('userAction')}}`].join('\n'))(...Object.values(deps)) as {userAction(id:string,action:string):Promise<void>}
  await app.userAction('target','sessions')
  expect(calls).toHaveLength(1)
  await confirm!()
  expect(calls[1]).toMatchObject({path:'/admin/api/users/target/revoke-sessions',options:{method:'POST',headers:{'If-Match':'"8"'}}})
})

it('self edit refreshes authorization and lands on an allowed page instead of rereading a forbidden account list', async () => {
  const current={id:'actor',revision:5,username:'actor',email:'actor@forge.local',display_name:'Actor',org_unit_id:null,role:'platform_admin',data_scope:'all',status:'active'}
  const state={session:{user:{id:'actor',role:'platform_admin',orgUnitId:null},permissions:['*']},grantableRoles:['user','platform_admin']}
  const location={hash:'#users'};let submit:((form:FormData)=>Promise<void>)|undefined;let entered=false
  const deps={bindRoleFields:()=>{},state,location,api:async(path:string)=>path==='/admin/api/org-units'?{items:[]}:path==='/auth/session'?{user:{id:'actor',role:'user'},permissions:['agent.view']}:current,openModal:(_title:string,_body:string,callback:typeof submit)=>{submit=callback},ROLE_LABELS:{},SCOPE_LABELS:{self:'本人',all:'全部'},idSeg:(id:string)=>id,toast:()=>{},renderUsers:async()=>{throw Error('forbidden account list must not run')},routeAfterLogin:()=> 'agents',enterApp:async()=>{entered=true}}
  const app=new Function(...Object.keys(deps),`${['esc','field','select','revisionHeaders','additionalRolesField'].map(fn).join('\n')}\nreturn {${method('openUser')}}`)(...Object.values(deps)) as {openUser(id:string):Promise<void>}
  await app.openUser('actor');const form=new FormData()
  for(const [key,value] of Object.entries({username:'actor',email:'actor@forge.local',displayName:'Actor',role:'user',dataScope:'self',status:'active',orgUnitId:''}))form.set(key,value)
  await submit!(form);expect(entered).toBe(true);expect(location.hash).toBe('agents');expect(state.session.user.role).toBe('user')
})
