import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyMessageResponse, renderMessageTemplate, webhookMessageHeaders, wecomTextBody } from "../packages/runtime/src/message-protocol.js";
const base = { cycleAttempts: 1, now: Date.UTC(2026, 10, 1), httpStatus: 200 };
describe("Frozen message protocol vectors; no real receiver", () => {
  it("preserves the legacy exact-body HMAC signature and stable identifiers", () => {
    const body = '{"id":"evt_run","data":{"value":"中"}}', secret = "technical-test-secret", timestamp = 1793491200;
    const headers = webhookMessageHeaders({ body, secret, timestamp, eventId: "evt_run", eventType: "run.completed", deliveryId: "delivery-one" });
    expect(headers["X-Forge-Signature"]).toBe(`t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`);
    expect(headers).toMatchObject({ "X-Forge-Event-Id": "evt_run", "X-Forge-Delivery-Id": "delivery-one" });
    expect(headers["X-Forge-Signature"]).not.toBe(webhookMessageHeaders({ body: JSON.stringify(JSON.parse(body), null, 2), secret, timestamp, eventId: "evt_run", eventType: "run.completed", deliveryId: "delivery-one" })["X-Forge-Signature"]);
  });
  it("renders only declared variables, rejects missing fields, expanded overflow and inline mention injection", () => {
    const template = { key: "status", name: "状态", content: "{{taskName}} {{executionId}}", variables: ["taskName", "executionId"] as ("taskName" | "executionId")[] };
    expect(renderMessageTemplate(template, { taskName: "任务", executionId: "example" })).toBe("任务 example");
    for (const values of [{ taskName: "任务" }, { taskName: "中".repeat(683), executionId: "x" }, { taskName: "<@all>", executionId: "x" }]) expect(() => renderMessageTemplate(template, values)).toThrow();
  });
  it("validates text UTF-8 boundaries and permits only explicit recipient lists", () => {
    expect(JSON.parse(wecomTextBody("中".repeat(682) + "ab", { mentionedIds: ["user.one"], mentionedMobiles: ["13800138000"] })).text).toMatchObject({ mentioned_list: ["user.one"], mentioned_mobile_list: ["13800138000"] });
    for (const [text, recipients] of [["中".repeat(683), {}], ["通知", { mentionedIds: ["@all"] }], ["<@all>", {}]] as const) expect(() => wecomTextBody(text, recipients)).toThrow();
  });
  it("requires a successful WeCom business envelope, never emits upstream secret-bearing error strings", () => {
    expect(classifyMessageResponse({ ...base, type: "wecom", responseBody: '{"errcode":0}' })).toMatchObject({ deliveryStatus: "delivered", retryDelayMs: null });
    const failed = classifyMessageResponse({ ...base, type: "wecom", responseBody: '{"errcode":40014,"errmsg":"private-secret"}' });
    expect(failed).toMatchObject({ deliveryStatus: "failed", responseSummary: "errcode 40014" });
    expect(JSON.stringify(failed)).not.toContain("private-secret");
    for (const responseBody of ["", "not-json", '{"errcode":"0"}', '{"ok":true}']) expect(classifyMessageResponse({ ...base, type: "wecom", responseBody }).deliveryStatus).toBe("unknown");
  });
  it("keeps uncertain group sends for manual review while retrying at-least-once webhook timeouts", () => {
    expect(classifyMessageResponse({ ...base, type: "wecom", httpStatus: null })).toMatchObject({ attemptStatus: "unknown", deliveryStatus: "unknown", retryDelayMs: null });
    expect(classifyMessageResponse({ ...base, type: "webhook", httpStatus: null })).toMatchObject({ attemptStatus: "unknown", deliveryStatus: "retry_wait", retryDelayMs: 60000 });
    expect(classifyMessageResponse({ ...base, type: "webhook", httpStatus: null, cycleAttempts: 6 })).toMatchObject({ attemptStatus: "unknown", deliveryStatus: "failed", retryDelayMs: null });
  });
  it("bounds temporary retries and honors Retry-After without multiplying attempts", () => {
    for (const errcode of [-1, 45009]) expect(classifyMessageResponse({ ...base, type: "wecom", responseBody: JSON.stringify({ errcode }) })).toMatchObject({ deliveryStatus: "retry_wait" });
    expect(classifyMessageResponse({ ...base, type: "wecom", httpStatus: 429, retryAfter: "180" }).retryDelayMs).toBe(180000);
    expect(classifyMessageResponse({ ...base, type: "webhook", httpStatus: 503, retryAfter: new Date(base.now + 300000).toUTCString() }).retryDelayMs).toBe(300000);
    expect(classifyMessageResponse({ ...base, type: "wecom", responseBody: '{"errcode":-1}', cycleAttempts: 6 }).deliveryStatus).toBe("failed");
    expect(classifyMessageResponse({ ...base, type: "webhook", httpStatus: 400 }).deliveryStatus).toBe("failed");
  });
});
it("ignores Retry-After values outside persistent scheduling bounds",()=>{
 for(const retryAfter of ["8640000000000","4294967296","Fri, 31 Dec 9999 23:59:59 GMT"]){
  const outcome=classifyMessageResponse({type:"webhook",cycleAttempts:1,httpStatus:429,retryAfter,now:Date.parse("2026-11-01T00:00:00Z")});expect(outcome).toMatchObject({attemptStatus:"failed",deliveryStatus:"retry_wait",retryDelayMs:60000});
 }
});
