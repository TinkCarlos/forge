import type { JobTransport } from "./job-client.js";
import type { MessageChannelCreateInput, MessageChannelPatchInput, MessageChannelDetail, MessageTemplateCreateInput, MessageTemplatePatchInput, MessageTemplateDetail, MessageTemplateVersion, MessageRuleCreateInput, MessageRulePatchInput, MessageRuleDetail, MessageDetail, MessageSummary, MessageAttempt } from "../../contracts/src/message-config.js";
import type { MessageRetry } from "../../contracts/src/job-messaging.js";
type Page<T> = {
    items: T[];
    nextCursor: string | null;
};
type Query = {
    cursor?: string;
    limit?: string;
    status?: string;
    channelId?: string;
    eventType?: string;
    sourceType?: string;
    sourceId?: string;
    from?: string;
    to?: string;
    createdFrom?:string;
    createdBefore?:string;
};
const search = (query: Query = {}) => { const params = new URLSearchParams(Object.entries(query).filter(([key, value]) => ["cursor", "limit", "status", "channelId", "eventType", "sourceType", "sourceId", "from", "to", "createdFrom", "createdBefore"].includes(key) && value !== undefined) as [
    string,
    string
][]).toString(); return params ? `?${params}` : ""; };
const headers = (revision: number, key?: string) => ({ "If-Match": `"${revision}"`, ...(key ? { "Idempotency-Key": key } : {}) });
export function createMessageClient(request: JobTransport) {
    function config<T, C, P>(kind: string) { const base = `/admin/api/message-${kind}`, path = (id: string) => `${base}/${encodeURIComponent(id)}`; return { list: (query: Query = {}) => request<Page<T>>(base + search(query)), get: (id: string) => request<T>(path(id)), create: (body: C) => request<T>(base, { method: "POST", body }), update: (id: string, revision: number, body: P) => request<T>(path(id), { method: "PATCH", body, headers: headers(revision) }), remove: (id: string, revision: number) => request<void>(path(id), { method: "DELETE", headers: headers(revision) }) }; }
    return {
        channels: { ...config<MessageChannelDetail, MessageChannelCreateInput, MessageChannelPatchInput>("channels"), versions: (id: string, cursor?: string) => request<Page<{
                id: string;
                version: number;
                endpointFingerprint: string;
                createdAt: string;
            }>>(`/admin/api/message-channels/${encodeURIComponent(id)}/versions` + search({ cursor })), test: (id: string, revision: number, key: string, body: {
                eventType: "test.webhook" | "test.wecom";
                templateVersionId?: string;
            }) => request<{
                deliveryId: string;
                statusUrl: string;
            }>(`/admin/api/message-channels/${encodeURIComponent(id)}/test`, { method: "POST", body, headers: headers(revision, key) }) },
        templates: { ...config<MessageTemplateDetail, MessageTemplateCreateInput, MessageTemplatePatchInput>("templates"), publish: (id: string, revision: number) => request<{
                versionId: string;
                version: number;
                revision: number;
                contentHash: string;
            }>(`/admin/api/message-templates/${encodeURIComponent(id)}/publish`, { method: "POST", body: {}, headers: headers(revision) }), versions: (id: string, cursor?: string) => request<Page<MessageTemplateVersion>>(`/admin/api/message-templates/${encodeURIComponent(id)}/versions` + search({ cursor })) },
        rules: config<MessageRuleDetail, MessageRuleCreateInput, MessageRulePatchInput>("rules"),
        deliveries: { list: (query: Query = {}) => request<Page<MessageSummary>>("/admin/api/message-deliveries" + search(query)), get: (id: string) => request<MessageDetail>(`/admin/api/message-deliveries/${encodeURIComponent(id)}`), attempts: (id: string, cursor?: string) => request<Page<MessageAttempt>>(`/admin/api/message-deliveries/${encodeURIComponent(id)}/attempts` + search({ cursor })), retry: (id: string, revision: number, key: string, body: MessageRetry) => request<{
                deliveryId: string;
                sendCycle: number;
                stateRevision: number;
                status: string;
            }>(`/admin/api/message-deliveries/${encodeURIComponent(id)}/retry`, { method: "POST", body, headers: headers(revision, key) }), cancel: (id: string, revision: number, key: string, body: {
                reason: string;
            }) => request<{
                deliveryId: string;
                stateRevision: number;
                status: string;
            }>(`/admin/api/message-deliveries/${encodeURIComponent(id)}/cancel`, { method: "POST", body, headers: headers(revision, key) }) },
    };
}
