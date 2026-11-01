import { readFileSync } from 'node:fs'
import { expect,it } from 'vitest'
const source=readFileSync(new URL('../../public/app.js',import.meta.url),'utf8')
const fn=(name:string)=>{const match=source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`,'m'));if(!match)throw Error(name);return match[0]}
const method=(name:string)=>{const match=source.match(new RegExp(`^  (?:async )?${name}\\([^)]*\\) \\{[\\s\\S]*?^  \\},?$`,'m'));if(!match)throw Error(name);return match[0].replace(/,$/,'')}

it('role-only users land on the function-permission tab without requiring account visibility',()=>{
  const groups=[{items:[{id:'users',anyPermissions:['user.view','role.view']},{id:'agents',permission:'agent.view'}]}]
  const choose=new Function('navGroups','canPermission',[fn('navAllowed'),fn('routeAfterLogin'),'return routeAfterLogin'].join('\n'))(groups,(code:string)=>code==='role.view') as (route:string)=>string
  expect(choose('dashboard')).toBe('users/roles');expect(choose('users')).toBe('users/roles');expect(choose('users/roles')).toBe('users/roles')
})
it('switching primary role enables the old choice and clears/disables the new primary additional grant',()=>{
  const inputs=[{dataset:{roleKey:'one'},disabled:false,checked:false},{dataset:{roleKey:'two'},disabled:false,checked:true}]
  let changed=()=>{};const primary={value:'one',addEventListener:(_type:string,callback:()=>void)=>{changed=callback}}
  const bind=new Function('$',`${fn('bindRoleFields')}\nreturn bindRoleFields`)((selector:string)=>selector.includes('select')?primary:{querySelectorAll:()=>inputs}) as ()=>void
  bind();expect(inputs.map(input=>input.disabled)).toEqual([true,false]);primary.value='two';changed();expect(inputs.map(input=>input.disabled)).toEqual([false,true]);expect(inputs[1]!.checked).toBe(false)
})
it('a stale role-list response cannot replace the account tab',async()=>{
  const state={tab:'users',accountSection:'roles',roleRequest:0};const content={innerHTML:'accounts'};let resolve!:(value:unknown)=>void
  const render=new Function('api','state','$',`${fn('renderRoles')}\nreturn renderRoles`)(()=>new Promise(done=>{resolve=done}),state,()=>content) as ()=>Promise<void>
  const request=render();state.accountSection='accounts';resolve({items:[],catalog:[]});await request;expect(content.innerHTML).toBe('accounts')
})
it('a failed old role navigation cannot overwrite a successful newer account navigation',async()=>{
  const state={navigation:0,session:{permissions:['role.view','user.view']},accountSection:'roles'};const content={innerHTML:'',textContent:''};let reject!:(error:Error)=>void
  const deps={state,location:{hash:''},tabMeta:{users:['账号与权限','']},$:()=>content,renderNav:()=>{},renderCurrent:()=>state.accountSection==='roles'?new Promise((_resolve,no)=>{reject=no}):Promise.resolve(content.innerHTML='accounts success'),errorCard:(error:Error)=>error.message,app:{openAgentDetail:()=>{throw Error('roles must not open Agent detail')}}}
  const go=new Function(...Object.keys(deps),[fn('parseRoute'),fn('canPermission'),fn('switchTab'),'return switchTab'].join('\n'))(...Object.values(deps)) as (route:string)=>Promise<void>
  const old=go('users/roles');await go('users');reject(Error('old roles failed'));await old;expect(content.innerHTML).toBe('accounts success')
})
it('role editing submits the captured version and permission checkboxes; a conflict retains the draft',async()=>{
  const current={id:'role-id',key:'custom',name:'Before',description:'',status:'active',permissions:['agent.view'],revision:7}
  const calls:Array<{path:string;options?:Record<string,unknown>}>=[];let body='',submit!: (data:FormData)=>Promise<void>;let saved=false
  const deps={state:{permissionCatalog:[]},api:async(path:string,options?:Record<string,unknown>)=>{calls.push({path,options});if(options)throw Object.assign(Error('Conflict'),{status:409});return current},idSeg:(id:string)=>id,openModal:(_title:string,html:string,callback:typeof submit)=>{body=html;submit=callback},toast:()=>{},errorText:(error:Error)=>error.message,afterRoleSave:async()=>{saved=true},permissionFields:()=>''}
  const app=new Function(...Object.keys(deps),`${['esc','field','select','textarea','revisionHeaders'].map(fn).join('\n')}\nreturn {${method('openRole')}}`)(...Object.values(deps)) as {openRole(id:string):Promise<void>}
  await app.openRole('role-id');const draft=body,form=new FormData();form.set('name','Draft');form.set('description','Preserved');form.set('status','active');form.append('permissions','agent.view');form.append('permissions','agent.run')
  await expect(submit(form)).rejects.toMatchObject({status:409});expect(body).toBe(draft);expect(saved).toBe(false)
  expect(calls[1]).toMatchObject({options:{method:'PATCH',headers:{'If-Match':'"7"'},body:{name:'Draft',permissions:['agent.view','agent.run']}}})
})
it('role writes refresh authorization after commit and do not ask users to repeat an already saved write on refresh failure',async()=>{
  const notices:string[]=[];const run=new Function('api','toast','errorText','state',`${fn('afterRoleSave')}\nreturn afterRoleSave`)(async()=>{throw Error('offline')},(message:string)=>notices.push(message),(error:Error)=>error.message,{}) as ()=>Promise<void>
  await expect(run()).resolves.toBeUndefined();expect(notices).toEqual(['配置已保存，刷新失败：offline'])
})

it('Agent and schedule readers do not request catalogues they cannot read',async()=>{
  for(const [name,permissions,expected] of [['renderDashboard',['agent.view'],['/admin/api/dashboard']],['renderSchedules',['schedule.view'],['/admin/api/schedules']]] as const){
    const calls:string[]=[],content={innerHTML:''};const state={session:{permissions:[...permissions]}};
    const deps={state,$:()=>content,api:async(path:string)=>{calls.push(path);if(!expected.some(value=>value===path))throw Error('unauthorized read');return path.endsWith('dashboard')?{agents:1}:{items:[]}},empty:()=>'',stat:()=>'',scheduleIdentity:()=>'',scheduleFailure:()=>'',fmt:()=>''}
    const render=new Function(...Object.keys(deps),[fn('esc'),fn('canPermission'),fn(name),`return ${name}`].join('\n'))(...Object.values(deps)) as ()=>Promise<void>
    await render();expect(calls).toEqual(expected);expect(content.innerHTML).not.toContain('新建定时任务');expect(content.innerHTML).not.toContain('最近运行')
  }
})

it('view-only capability pages hide writes while preserving visible rows',async()=>{
  const cases=[['renderAgents','agent.view',['试运行','新版本','新建 Agent','开放 API']],['renderModels','model.view',['添加 Provider','添加模型','编辑 Provider','测试连接']],['renderMcp','mcp.view',['添加 MCP','刷新工具','>编辑<']],['renderSkills','skill.view',['新建 Skill','>编辑<']],['renderTools','tool.view',['导入 OpenAPI</button>']],['renderPackages','package.view',['安装能力包','>卸载<']],['renderRuns','run.view',['>取消<']]] as const
  for(const [name,permission,hidden] of cases){
    const content={innerHTML:''};const deps={state:{tab:name==='renderRuns'?'runs':'agents',session:{permissions:[permission]}},$:()=>content,api:async()=>({items:[{id:'fixture',key:'fixture',name:'fixture',status:'running',description:'',models:[],version:'1.0.0',type:'mixed',draftVersion:{version:'2.0.0'},costUsd:0}]}),bindAgentActions:()=>{},fmt:()=>'',vLabel:()=>''}
    const render=new Function(...Object.keys(deps),[fn('esc'),fn('empty'),fn('statusPill'),fn('canPermission'),fn(name),`return ${name}`].join('\n'))(...Object.values(deps)) as ()=>Promise<void>
    await render();expect(content.innerHTML).toContain('fixture');const buttons=content.innerHTML.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.join('')??'';for(const text of hidden)expect(buttons,`${name}: ${text}`).not.toContain(text)
  }
})

it('Agent detail resolving after navigation does not open a stale modal',async()=>{
  const state={navigation:1};let resolve!:(value:unknown)=>void;let dialogs=0;
  const deps={state,api:()=>new Promise(done=>{resolve=done}),idSeg:(id:string)=>id,openModal:()=>{dialogs++},json:()=>'',toast:()=>{},errorText:()=>''}
  const app=new Function(...Object.keys(deps),`return {${method('openAgentDetail')}}`)(...Object.values(deps)) as {openAgentDetail(id:string,navigation:number):Promise<void>}
  const pending=app.openAgentDetail('known',1);state.navigation=2;resolve({name:'old Agent'});await pending;expect(dialogs).toBe(0)
})
