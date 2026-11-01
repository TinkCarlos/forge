import { createHmac } from "node:crypto";
import { ForgeError } from "@forge/core";
import { MESSAGE_TEMPLATE_SCHEMA, MESSAGE_TEXT_MAX_BYTES, WECOM_RECIPIENTS_SCHEMA, type MessageTemplate } from "@forge/contracts";
import { webhookRetryDelayMs, webhookShouldRetry } from "./webhook.js";

export function renderMessageTemplate(template: MessageTemplate, values: Partial<Record<MessageTemplate["variables"][number], string>>): string {
  const parsed = MESSAGE_TEMPLATE_SCHEMA.safeParse(template);
  if (!parsed.success) throw new ForgeError("MSG-7206");
  const content = parsed.data.content.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_match, key: MessageTemplate["variables"][number]) => {
    const value = values[key];
    if (typeof value !== "string") throw new ForgeError("MSG-7204", { message: "消息缺少模板变量" });
    return value;
  });
  if (Buffer.byteLength(content, "utf8") > MESSAGE_TEXT_MAX_BYTES || /<@[^>]*>/.test(content)) throw new ForgeError("MSG-7204", { message: "消息内容超限或包含未授权提醒" });
  return content;
}
export function wecomTextBody(content: string, recipients: unknown): string {
  const parsed = WECOM_RECIPIENTS_SCHEMA.safeParse(recipients);
  if (!parsed.success || !content || Buffer.byteLength(content, "utf8") > MESSAGE_TEXT_MAX_BYTES || /<@[^>]*>/.test(content)) throw new ForgeError("MSG-7204");
  return JSON.stringify({ msgtype: "text", text: { content, mentioned_list: parsed.data.mentionedIds, mentioned_mobile_list: parsed.data.mentionedMobiles } });
}
export function webhookMessageHeaders(input: { eventId: string; eventType: string; deliveryId: string; body: string; timestamp: number; secret: string }): Record<string, string> {
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0 || !input.secret || [input.eventId, input.eventType, input.deliveryId].some(value => !value || /[^\x21-\x7e]/.test(value))) throw new ForgeError("MSG-7206");
  const signature = createHmac("sha256", input.secret).update(`${input.timestamp}.${input.body}`).digest("hex");
  return { "Content-Type": "application/json", "X-Forge-Event-Id": input.eventId, "X-Forge-Event-Type": input.eventType, "X-Forge-Delivery-Id": input.deliveryId, "X-Forge-Timestamp": String(input.timestamp), "X-Forge-Signature": `t=${input.timestamp},v1=${signature}` };
}
export interface MessageOutcome {
  attemptStatus: "succeeded" | "failed" | "unknown";
  deliveryStatus: "delivered" | "failed" | "unknown" | "retry_wait";
  errorCode: "MSG-7204" | "MSG-7205" | null;
  responseSummary: string | null;
  retryDelayMs: number | null;
}
export function classifyMessageResponse(input: { type: "webhook" | "wecom"; cycleAttempts: number; httpStatus: number | null; responseBody?: string; retryAfter?: string | null; now: number }): MessageOutcome {
  if (!Number.isInteger(input.cycleAttempts) || input.cycleAttempts < 1 || input.cycleAttempts > 6 || !Number.isFinite(input.now)) throw new ForgeError("MSG-7206");
  const unknown = (): MessageOutcome => ({ attemptStatus: "unknown", deliveryStatus: "unknown", errorCode: "MSG-7205", responseSummary: null, retryDelayMs: null });
  const succeeded = (): MessageOutcome => ({ attemptStatus: "succeeded", deliveryStatus: "delivered", errorCode: null, responseSummary: null, retryDelayMs: null });
  const failed = (retryable: boolean, responseSummary: string | null, uncertain = false): MessageOutcome => {
    let delay = retryable ? webhookRetryDelayMs(input.cycleAttempts) : null;
    if (delay !== null && input.retryAfter) {
      const seconds = /^\d+$/.test(input.retryAfter) ? Number(input.retryAfter) : null;
      const requested = seconds !== null ? seconds * 1000 : Date.parse(input.retryAfter) - input.now;
      if (Number.isSafeInteger(requested) && requested > delay && requested <= Math.min(4_294_967_295_000,253_402_300_799_999-input.now)) delay = requested;
    }
    return { attemptStatus: uncertain ? "unknown" : "failed", deliveryStatus: delay === null ? "failed" : "retry_wait", errorCode: uncertain ? "MSG-7205" : "MSG-7204", responseSummary, retryDelayMs: delay };
  };
  if (input.httpStatus === null) return input.type === "wecom" ? unknown() : failed(true, null, true);
  if (input.type === "webhook") return input.httpStatus >= 200 && input.httpStatus < 300 ? succeeded() : failed(webhookShouldRetry(input.httpStatus), `HTTP ${input.httpStatus}`);
  if (input.httpStatus === 429) return failed(true, "HTTP 429");
  let body: unknown;
  try { body = input.responseBody && Buffer.byteLength(input.responseBody, "utf8") <= 65536 ? JSON.parse(input.responseBody) : null; } catch { return unknown(); }
  if (!body || typeof body !== "object" || !("errcode" in body) || typeof body.errcode !== "number" || !Number.isSafeInteger(body.errcode)) return unknown();
  if (body.errcode === 0) return input.httpStatus >= 200 && input.httpStatus < 300 ? succeeded() : unknown();
  // WeCom's official error registry identifies busy/rate-limit responses as explicit temporary rejection.
  return failed(body.errcode === -1 || body.errcode === 45009, `errcode ${body.errcode}`);
}
