import {wecomTargetIdentity} from "@forge/contracts";
import type { PoolConnection } from "mysql2/promise";
import { ForgeError, hasPermission, readAuthorization, safeFetch, sha256, type Principal, type DataScope } from "@forge/core";
import { messageDeliveryRepo, messageConfigRepo, messageFanoutRepo, agentJobTargets, repos, type MessageDeliveryRow, type MessageChannelRow, type ClaimedMessage } from "@forge/store";
import { resourceFilterFor } from "@forge/governance";
import { toPrincipal } from "@forge/identity";
import { classifyMessageResponse, type MessageOutcome, webhookMessageHeaders } from "./message-protocol.js";
import { fanoutMessages } from "./message-fanout.js";
import { describeTickError } from "./tick-guard.js";
async function authorize(row: MessageDeliveryRow, channel: MessageChannelRow, conn: PoolConnection): Promise<boolean> {
    if (!["test", "run"].includes(row.source_type))
        return false;
    if (row.subject_type === "app") {
        if (row.source_type !== "run" || !row.app_id || row.subject_id !== row.app_id)
            return false;
        const source = await messageFanoutRepo.appRunSource(row.source_id, row.app_id, conn);
        return !!source && (channel.owner_org_unit_id === null || channel.owner_org_unit_id === source.org_unit_id);
    }
    const subject = row.subject_type === "user" ? await repos.getActiveUserById(row.subject_id, conn) : await repos.getActiveServiceAccountById(row.subject_id, conn);
    if (!subject)
        return false;
    const principal: Principal = row.subject_type === "user" ? toPrincipal(subject as Parameters<typeof toPrincipal>[0]) : { type: "service", id: subject.id, name: subject.id, role: subject.role, orgUnitId: subject.org_unit_id, dataScope: subject.data_scope as DataScope, permissions: readAuthorization(subject.authorization_json).permissions };
    if (row.source_type === "test")
        return hasPermission(principal, "message.test") && !!await messageConfigRepo.getMessageChannel(channel.id, await resourceFilterFor(principal, "message_channel", "test", conn), conn);
    if (!hasPermission(principal, "agent.run"))
        return false;
    const source = await messageFanoutRepo.runSource(row.source_id, await resourceFilterFor(principal, "run", "view", conn), conn);
    if (!source || (channel.owner_org_unit_id !== null && channel.owner_org_unit_id !== source.org_unit_id))
        return false;
    return (await agentJobTargets(await resourceFilterFor(principal, "agent", "run", conn), conn)).some(agent => agent.id === source.agent_id);
}
async function responseText(response: Response): Promise<string> {
    if (!response.body)
        return "";
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > 65536) {
                await reader.cancel();
                return "";
            }
            chunks.push(value);
        }
        return Buffer.concat(chunks).toString("utf8");
    }
    finally {
        reader.releaseLock();
    }
}
async function resolve(claim: ClaimedMessage) {
    const id = claim.version.id, bindings: Record<string, string> = { [`endpoint-version:${id}`]: claim.version.endpoint_secret_id };
    if (claim.version.signing_secret_id)
        bindings[`signing:${id}`] = claim.version.signing_secret_id;
    for (const [name, secret] of Object.entries(claim.version.header_refs_json))
        bindings[`header:${id}:${name.toLowerCase()}`] = secret;
    const values = await repos.resolveCredentialValues(claim.channel.credential_owner_type, claim.channel.credential_owner_id, bindings), url = values[`endpoint-version:${id}`]!;
    if (sha256(url) !== claim.version.endpoint_fingerprint)
        throw new ForgeError("MSG-7202");
    const headers = Object.fromEntries(Object.keys(claim.version.header_refs_json).map(name => [name, values[`header:${id}:${name.toLowerCase()}`]!]));
    const identity=claim.channel.type==="wecom"?wecomTargetIdentity(url):null;
    if(claim.channel.type==="wecom"&&!identity)throw new ForgeError("MSG-7202");
    return { url,headers,secret:values[`signing:${id}`],throttleKey:identity?sha256(identity):null };
}
function unavailable(): MessageOutcome { return { attemptStatus: "failed", deliveryStatus: "failed", errorCode: "MSG-7204", responseSummary: null, retryDelayMs: null }; }
export async function deliverMessages(workerId: string, transport: typeof safeFetch = safeFetch): Promise<number> {
    await fanoutMessages();
    const due = await messageDeliveryRepo.due();
    for (const row of due) {
        try {
            const expired = await messageDeliveryRepo.expiredClaim(row.id, row.channel_id);
            if (expired) {
                const outcome = expired.attempt.status === "prepared" ? { ...unavailable(), deliveryStatus: expired.delivery.cycle_attempts < 6 ? "retry_wait" as const : "failed" as const, retryDelayMs: expired.delivery.cycle_attempts < 6 ? 0 : null } : classifyMessageResponse({ type: expired.channel.type, cycleAttempts: expired.delivery.cycle_attempts, httpStatus: null, now: Date.now() });
                await messageDeliveryRepo.complete(expired, outcome, null);
                continue;
            }
            const claim = await messageDeliveryRepo.prepare(row.id, row.channel_id, workerId, authorize);
            if (!claim)
                continue;
            // Validate current Secret availability before granting dispatch, then resolve again after the commit.
            let quotaKey:string|null=null;
            try {
                quotaKey=(await resolve(claim)).throttleKey;
            }
            catch {
                await messageDeliveryRepo.complete(claim, unavailable(), null, true);
                continue;
            }
            if (!await messageDeliveryRepo.submit(claim, authorize,quotaKey))
                continue;
            let target: Awaited<ReturnType<typeof resolve>>;
            try {
                target = await resolve(claim);
            }
            catch {
                await messageDeliveryRepo.complete(claim, unavailable(), null, true);
                continue;
            }
            const body = claim.delivery.payload_body!.toString("utf8");
            if (sha256(body) !== claim.delivery.payload_hash) {
                await messageDeliveryRepo.complete(claim, unavailable(), null);
                continue;
            }
            let status: number | null = null, responseBody: string | undefined, retryAfter: string | null = null, blocked = false;
            try {
                const headers = claim.channel.type === "webhook" ? { ...target.headers, ...webhookMessageHeaders({ eventId: claim.delivery.event_id, eventType: claim.delivery.event_type, deliveryId: claim.delivery.id, body, timestamp: Math.floor(Date.now() / 1000), secret: target.secret! }) } : { ...target.headers, "Content-Type": "application/json" };
                const response = await transport(target.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10000), redirect: "manual" });
                status = response.status;
                retryAfter = response.headers.get("retry-after");
                if (claim.channel.type === "wecom")
                    responseBody = await responseText(response);
                else
                    await response.body?.cancel();
            }
            catch (error) {
                blocked = error instanceof ForgeError && ["HTP-4003", "SYS-9002"].includes(error.code);
            }
            const outcome = blocked ? unavailable() : classifyMessageResponse({ type: claim.channel.type, cycleAttempts: claim.delivery.cycle_attempts, httpStatus: status, responseBody, retryAfter, now: Date.now() });
            await messageDeliveryRepo.complete(claim, outcome, status);
        }
        catch (error) {
            console.error(`Message delivery failed: ${describeTickError(error)}`);
        }
    }
    return due.length;
}
