import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const fn = (name:string) => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))
  if (!match) throw Error(`missing ${name}`)
  return match[0]
}
const method = (name:string) => {
  const match = source.match(new RegExp(`^  (?:async )?${name}\\([^)]*\\) \\{[\\s\\S]*?^  \\},?$`, 'm'))
  if (!match) throw Error(`missing ${name}`)
  return match[0].replace(/,$/,'')
}
type Modal = {title:string;body:string;submit:(data:unknown)=>Promise<unknown>}
function harness() {
  const modals:Modal[] = [], calls:Array<{path:string;opts:{body:Record<string,unknown>}}> = []
  const state = {session:{permissions:['*']},providers:[{id:'p1',revision:3,name:'P',baseUrl:'https://llm.example',secretId:'old',headerSecretRefs:{'x-token':'old'}}],mcp:[{id:'m1',revision:4,name:'M',url:'https://mcp.example',headerSecretRefs:{'x-token':'old'}}]}
  const deps = {state,openModal:(title:string,body:string,submit:Modal['submit'])=>modals.push({title,body,submit}), api:async(path:string,opts:{body:Record<string,unknown>})=>{calls.push({path,opts});return {revision:5}},toast:()=>{},renderModels:async()=>{},renderMcp:async()=>{},idSeg:(v:string)=>v}
  const names = Object.keys(deps)
  const helpers = ['esc','field','textarea','recordFields','recordRow','recordValueFields','revisionHeaders','parseJsonField','canManageSecrets','credentialReferenceField','credentialReferenceChange','credentialHeaderFields','credentialHeadersChange'].map(fn).join('\n')
  const app = new Function(...names, `${helpers}\nreturn {${['openProviderEdit','openMcpEdit'].map(method).join(',')}}`)(...Object.values(deps)) as {openProviderEdit(id:string):void;openMcpEdit(id:string):void}
  return {state,modals,calls,app}
}
const form = (values:Record<string,string>) => ({get:(name:string)=>values[name] ?? null})
describe('SEC10 resource credential editors preserve bindings',()=>{
  it('does not send empty headers/references during a metadata-only edit', async()=>{
    const h = harness(); h.app.openProviderEdit('p1')
    expect(h.modals[0]!.body).toContain('data-credential-input')
    expect(h.modals[0]!.body).not.toContain('name="headers" rows="4">{}')
    await h.modals[0]!.submit(form({name:'Renamed',baseUrl:'https://llm.example',apiKey:'',secretId:'old',headers:'',headerSecretRefs:'{"x-token":"old"}'}))
    expect(h.calls[0]!.opts.body).toEqual({name:'Renamed',baseUrl:'https://llm.example',apiKey:undefined})
    h.app.openMcpEdit('m1')
    await h.modals[1]!.submit(form({name:'M',url:'https://mcp.example',headers:'',headerSecretRefs:'{"x-token":"old"}'}))
    expect(h.calls[1]!.opts.body).toEqual({name:'M',url:'https://mcp.example'})
  })
  it('replaces an explicit header value while preserving other references, and supports deliberate clear',async()=>{
    const h=harness();h.state.providers[0]!.headerSecretRefs={'x-token':'old','x-other':'kept'} as typeof h.state.providers[0]['headerSecretRefs']
    h.app.openProviderEdit('p1')
    await h.modals[0]!.submit(form({name:'P',baseUrl:'https://llm.example',apiKey:'',secretId:'old',headers:'{"X-Token":"new-value"}',headerSecretRefs:'{"x-token":"old","x-other":"kept"}'}))
    expect(h.calls[0]!.opts.body).toMatchObject({headers:{'X-Token':'new-value'},headerSecretRefs:{'x-other':'kept'}})
    h.app.openProviderEdit('p1')
    await h.modals[1]!.submit(form({name:'P',baseUrl:'https://llm.example',apiKey:'',secretId:'',headers:'{}',headerSecretRefs:'{}'}))
    expect(h.calls[1]!.opts.body).toMatchObject({secretId:null,headers:{},headerSecretRefs:{}})
  })
  it('does not submit a value and a changed reference together',async()=>{
    const h=harness();h.app.openProviderEdit('p1')
    await expect(h.modals[0]!.submit(form({apiKey:'new-value',secretId:'different'}))).rejects.toThrow('凭据值和引用不能同时指定')
    expect(h.calls).toHaveLength(0)
  })
})
