import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callMcpTool, discoverMcpTools, executeOpenApiTool } from "@forge/capabilities";
import { config } from "@forge/core";
import { callModel } from "@forge/models";
import { deliverDueWebhooks } from "@forge/runtime";
import { execute, one, query, repos } from "@forge/store";

const canary = "synthetic-transport-credential-92", replacement = "rotated-transport-credential-93";
const resources: Array<{ type: "llm_provider" | "mcp_server" | "tool_source" | "api_app"; id: string }> = [];
const secrets = new Set<string>();
const requests: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
let server: Server, base = "", providerKey = "", providerId = "", mcpId = "", sourceId = "", appId = "";
let mode: "json" | "sse" | "structured" | "name-echo" | "property-echo" | "json-key-echo" | "error" = "json";
const savedAllowlist = config.OUTBOUND_ALLOWLIST;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const path = req.url ?? ""; requests.push({path, headers:req.headers, body});
      const value = String(req.headers["x-custom-token"] ?? req.headers.authorization ?? "");
      if (path.endsWith("/chat/completions")) {
        if (mode === "error") { res.writeHead(502, {"content-type":"text/plain"}).end(`failure ${value}`); return; }
        if (mode === "sse") {
          res.writeHead(200, {"content-type":"text/event-stream"});
          for (const delta of ["before ",value.slice(0, 5),value.slice(5, 12),value.slice(12)," after"]) res.write(`data: ${JSON.stringify({choices:[{delta:{content:delta}}]})}\n\n`);
          res.end(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:8,completion_tokens:6}})}\n\ndata: [DONE]\n\n`); return;
        }
        res.writeHead(200, {"content-type":"application/json"}).end(JSON.stringify({choices:[{message:{content:mode === "structured" ? JSON.stringify({payload:`echo ${value}`,limit:123}) : `echo ${value}`,tool_calls:[{id:"call_1",type:"function",function:{name:"ship",arguments:JSON.stringify({payload:value,limit:123})}}]}}],usage:{prompt_tokens:8,completion_tokens:6}})); return;
      }
      if (path === "/mcp") {
        const rpc = JSON.parse(body) as {method:string;id?:number};
        const result = rpc.method === "tools/list" ? {tools:[{name:mode === "name-echo" ? `echo_${value}` : "ship",description:`uses ${value}`,inputSchema:{type:"object",properties:{[mode === "property-echo" ? `echo_${value}` : "payload"]:{type:"string",description:`${value}`}},required:["payload"]},annotations:{readOnlyHint:true}}]}
          : rpc.method === "tools/call" ? {content:[{type:"text",text:`echo ${value}`}]} : {protocolVersion:"2025-06-18",capabilities:{},serverInfo:{name:"synthetic",version:"1"}};
        res.writeHead(200, {"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result})); return;
      }
      if (path === "/items") { res.writeHead(mode === "error" ? 503 : 200, {"content-type":"text/plain"}).end(mode === "json-key-echo" ? JSON.stringify({[`echo_${value}`]:"echo"}) : `echo ${value}`); return; }
      res.writeHead(204).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const port = (server.address() as AddressInfo).port; base = `http://127.0.0.1:${port}`; config.OUTBOUND_ALLOWLIST = `127.0.0.1:${port}`;
  providerKey = `it-secret-http-${randomUUID()}`;
  providerId = await repos.createProvider({key:providerKey,name:"Synthetic provider",protocol:"openai-compatible",baseUrl:base,apiKey:canary,headers:{"X-Custom-Token":canary,"Accept-Language":"en","X-Role":"user","X-Type":"string","X-Number":"123"}});
  resources.push({type:"llm_provider",id:providerId});
  await repos.createModel({providerId,key:"synthetic",displayName:"Synthetic",inputPrice:1,outputPrice:2});
  mcpId = await repos.createMcpServer({key:`it-secret-http-${randomUUID()}`,name:"Synthetic MCP",url:`${base}/mcp`,headers:{"X-Custom-Token":canary,"Accept-Language":"en"}}); resources.push({type:"mcp_server",id:mcpId});
  sourceId = await repos.createToolSource({key:`it-secret-http-${randomUUID()}`,name:"Synthetic OpenAPI",baseUrl:base,spec:{},headers:{"X-Custom-Token":canary}}); resources.push({type:"tool_source",id:sourceId});
  appId = await repos.createApiApp({key:`it-secret-http-${randomUUID()}`,name:"Synthetic webhook",scopes:[],webhookUrl:`${base}/webhook`,webhookSecret:` \n${canary}  `}); resources.push({type:"api_app",id:appId});
});
afterAll(async () => {
  config.OUTBOUND_ALLOWLIST = savedAllowlist;
  for (const {type,id} of resources) {
    const refs = await query<{to_id:string}>("SELECT to_id FROM resource_references WHERE from_type = ? AND from_id = ?",[type,id]); refs.forEach(ref => secrets.add(ref.to_id));
    await execute("DELETE FROM resource_references WHERE from_type = ? AND from_id = ?",[type,id]);
    if (type === "llm_provider") await execute("DELETE FROM llm_models WHERE provider_id = ?",[id]);
    if (type === "api_app") await execute("DELETE FROM webhook_deliveries WHERE app_id = ?",[id]);
    const table = {llm_provider:"llm_providers",mcp_server:"mcp_servers",tool_source:"tool_sources",api_app:"api_apps"}[type];
    await execute(`DELETE FROM ${table} WHERE id = ?`,[id]);
  }
  for (const id of secrets) { await execute("DELETE FROM secret_versions WHERE secret_id = ?",[id]); await execute("DELETE FROM secrets WHERE id = ?",[id]); }
  await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
});

const modelCall = (onDelta?: (value:string) => void) => callModel({providerKey,modelKey:"synthetic",messages:[{role:"user",content:`hello ${canary}`}],tools:[{name:"ship",description:`send ${canary}`,parameters:{type:"object",properties:{payload:{type:"string",description:canary}},required:["payload"]},risk:"low"}],onDelta});
const disable = (id:string) => repos.updateSecret(id,{status:"disabled"},{expectedRevision:"system"});

describe("SEC07 real HTTP boundaries inject, mask echoes and stop after revocation", () => {
  it("injects bearer/headers, preserves model protocol and usage, and masks JSON/SSE/error echoes", async () => {
    const result = await modelCall();
    expect(result.content).not.toContain(canary); expect(result.toolCalls[0]!.name).toBe("ship"); expect(result.toolCalls[0]!.arguments).not.toContain(canary);
    expect(result.usage).toEqual({inputTokens:8,outputTokens:6,costUsd:0.000020});
    const sent = requests.at(-1)!; expect(sent.headers.authorization).toBe(`Bearer ${canary}`); expect(sent.headers["x-custom-token"]).toBe(canary);
    const body = JSON.parse(sent.body); expect(body.messages[0]).toEqual({role:"user",content:"hello ***"});
    expect(body.tools[0]).toMatchObject({type:"function",function:{name:"ship",parameters:{type:"object",properties:{payload:{type:"string"}},required:["payload"]}}});
    expect(sent.body).not.toContain(canary);
    mode = "structured"; const structured = await modelCall();
    expect(JSON.parse(structured.content)).toEqual({payload:"echo ***",limit:123});
    expect(JSON.parse(structured.toolCalls[0]!.arguments)).toEqual({payload:"***",limit:123});
    mode = "sse"; const deltas:string[] = []; const stream = await modelCall(delta => { deltas.push(delta); });
    expect(deltas.join("")).toBe(stream.content); expect(stream.content).toBe("before *** after"); expect(stream.usage.inputTokens).toBe(8);
    mode = "error";
    try { await modelCall(); throw Error("expected failure"); } catch (error) { expect(error).toMatchObject({code:"MDL-3001"}); expect(JSON.stringify(error)).not.toContain(canary); }
    mode = "json";
  });
  it("injects MCP discovery/call and OpenAPI without exposing values in metadata or results", async () => {
    const mcp = (await repos.getMcpServer(mcpId))!;
    const tools = await discoverMcpTools(mcp); expect(tools[0]).toMatchObject({name:"ship",inputSchema:{type:"object",properties:{payload:{type:"string"}}}});
    mode = "name-echo"; await expect(discoverMcpTools(mcp)).rejects.toMatchObject({code:"SYS-9002"});
    mode = "property-echo"; await expect(discoverMcpTools(mcp)).rejects.toMatchObject({code:"SYS-9002"}); mode = "json";
    expect(JSON.stringify(tools)).not.toContain(canary); expect(JSON.stringify(tools)).not.toContain("cont***t");
    expect(await callMcpTool(mcp,"send",{})).toMatchObject({ok:true,content:"echo ***"});
    const source = (await repos.getToolSourceByKey(String((await one<{key:string}>("SELECT `key` FROM tool_sources WHERE id = ?",[sourceId]))!.key)))!;
    expect(await executeOpenApiTool({source,tool:{method:"GET",path:"/items"},args:{}})).toMatchObject({ok:true,content:"echo ***"});
    mode = "json-key-echo"; await expect(executeOpenApiTool({source,tool:{method:"GET",path:"/items"},args:{}})).rejects.toMatchObject({code:"SYS-9002"});
    mode = "error";
    expect(await executeOpenApiTool({source,tool:{method:"GET",path:"/items"},args:{}})).toMatchObject({ok:false,content:"echo ***",errorCode:"HTP-4002"}); mode = "json";
    for (const path of ["/mcp","/items"]) expect(requests.filter(r => r.path === path).every(r => r.headers["x-custom-token"] === canary)).toBe(true);
  });
  it("signs with the exact HMAC bytes and adopts a rotated version without restart", async () => {
    const app = (await repos.getApiApp(appId))!, id = String(app.webhook_secret_id);
    for (const value of [` \n${canary}  `,replacement]) {
      if (value === replacement) await repos.rotateSecret(id,value,{expectedRevision:1});
      const delivery = await repos.enqueueWebhook({appId,eventId:`it-${randomUUID()}`,eventType:"run.completed",payload:{ok:true}});
      await deliverDueWebhooks(); const sent = requests.at(-1)!;
      expect(sent.path).toBe("/webhook"); expect((await repos.getWebhookDelivery(delivery!))!.status).toBe("delivered");
      const timestamp = sent.headers["x-forge-timestamp"], expected = createHmac("sha256",value).update(`${timestamp}.${sent.body}`).digest("hex");
      expect(sent.headers["x-forge-signature"]).toBe(`t=${timestamp},v1=${expected}`); expect(sent.body).not.toContain(canary);
    }
  });
  it("does not send any of the five HTTP requests after disabling their bound credentials", async () => {
    const p = (await repos.getProviderById(providerId))!, mcp = (await repos.getMcpServer(mcpId))!;
    const source = (await one("SELECT * FROM tool_sources WHERE id = ?",[sourceId]))!, app = (await repos.getApiApp(appId))!;
    for (const id of [p.secret_id!, Object.values(mcp.header_secret_refs_json as Record<string,string>)[0]!, Object.values(source.header_secret_refs_json as Record<string,string>)[0]!, String(app.webhook_secret_id)]) await disable(id);
    // Legacy residue must never become a fallback around a revoked new reference.
    await execute("UPDATE llm_providers SET api_key_encrypted = 'v1.bad.bad.bad' WHERE id = ?",[providerId]);
    const before = requests.length;
    await expect(modelCall()).rejects.toMatchObject({code:"SYS-9002"});
    await expect(discoverMcpTools(mcp)).rejects.toMatchObject({code:"SYS-9002"});
    await expect(callMcpTool(mcp,"send",{})).rejects.toMatchObject({code:"SYS-9002"});
    await expect(executeOpenApiTool({source,tool:{method:"GET",path:"/items"},args:{}})).rejects.toMatchObject({code:"SYS-9002"});
    const delivery = await repos.enqueueWebhook({appId,eventId:`it-${randomUUID()}`,eventType:"run.completed",payload:{}}); await deliverDueWebhooks();
    expect(await repos.getWebhookDelivery(delivery!)).toMatchObject({status:"failed",error_code:"SYS-9002"});
    expect(requests).toHaveLength(before);
  });
});
