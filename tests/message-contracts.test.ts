import {readFileSync} from "node:fs";
import {expect,it} from "vitest";
import {MESSAGES_OPENAPI,MESSAGE_HTTP_SCHEMAS,MESSAGE_CHANNEL_CREATE_SCHEMA} from "@forge/contracts";
it("keeps all 24 management operations and generated OpenAPI synchronized",()=>{
 const artifact:unknown=JSON.parse(readFileSync(new URL("../docs/03-api/messages.openapi.json",import.meta.url),"utf8"));expect(artifact).toEqual(MESSAGES_OPENAPI);expect(Object.values(MESSAGES_OPENAPI.paths).reduce((count,path)=>count+Object.keys(path).length,0)).toBe(24);
});
it("keeps unions strict and typed in structural HTTP schemas while trimming keys semantically",()=>{
 const body=MESSAGE_HTTP_SCHEMAS.channelCreate.body;expect(body.additionalProperties).toBe(false);expect(body.properties?.endpoint).toMatchObject({type:["object"]});expect(body.properties?.key).not.toHaveProperty("pattern");
 expect(MESSAGE_CHANNEL_CREATE_SCHEMA.safeParse({key:"  technical-channel  ",name:"样本",type:"wecom",endpoint:{value:"https://example.invalid/technical"}})).toMatchObject({success:true,data:{key:"technical-channel"}});
 expect(MESSAGE_HTTP_SCHEMAS.versionPage.querystring.properties).not.toHaveProperty("status");
});
