import { AsyncLocalStorage } from "node:async_hooks";

/**
 * P3-10 (architect ruling 3): request facts added to every audit row written while serving a request, as keys of
 * details_json (no new column): ip (request.ip, i.e. X-Forwarded-For only when the app trusts a proxy), userAgent
 * (at most 512 characters, null when absent) and requestId. The API sets the context per request; audits written
 * outside a request (worker, scripts) get none of the keys.
 */
export type AuditRequestContext = { ip: string | null; userAgent: string | null; requestId: string | null };

export const AUDIT_USER_AGENT_MAX = 512;

const storage = new AsyncLocalStorage<AuditRequestContext>();

export function runWithAuditContext<T>(context: AuditRequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function auditRequestContext(): AuditRequestContext | undefined {
  return storage.getStore();
}

/** User-Agent as stored in audit details: a non-empty string cut to 512 characters (code points), else null. */
export function auditUserAgent(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const chars = Array.from(value);
  return chars.length > AUDIT_USER_AGENT_MAX ? chars.slice(0, AUDIT_USER_AGENT_MAX).join("") : value;
}

/** details_json with the request keys merged in (they win over same-named caller keys). */
export function withAuditRequestDetails(details: unknown): unknown {
  const context = storage.getStore();
  if (!context) return details ?? {};
  const base = details === undefined || details === null ? {} : typeof details === "object" && !Array.isArray(details) ? details : { value: details };
  return { ...base, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId };
}
