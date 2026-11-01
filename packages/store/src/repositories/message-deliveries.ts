import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { ForgeError, MAX_REVISION, newId, sha256, type QueryFilter } from "@forge/core";
import { JOB_IDEMPOTENCY_KEY_SCHEMA, validWecomPayload, type MessageRetry, type MessageStatus } from "@forge/contracts";
import { one, query, transaction } from "../db.js";
import { jobFilterSql } from "../job-filter.js";
import { boundPageCursor, readBoundPageCursor } from "../pagination.js";
import { messageConfigRepo, type MessageChannelRow, type ChannelVersionRow, type MessageWrite } from "./message-config.js";
import { auditRepo } from "./audit.js";
export interface MessageDeliveryRow extends RowDataPacket {
    id: string;
    event_id: string;
    event_type: string;
    source_type: string;
    source_id: string;
    source_generation: number;
    owner_org_unit_id: string | null;
    subject_type: "user" | "service" | "app";
    subject_id: string;
    app_id: string | null;
    channel_id: string;
    channel_version_id: string;
    matched_rules_json: unknown;
    template_version_id: string | null;
    payload_body: Buffer | null;
    payload_hash: string;
    status: MessageStatus;
    hold_reason: string | null;
    cancel_requested: number;
    state_revision: number;
    send_cycle: number;
    cycle_attempts: number;
    total_attempts: number;
    next_attempt_at: Date | null;
    claimed_by: string | null;
    lease_expires_at: Date | null;
    fence_token: string;
    authorized_epoch: string;
    historical_target_ack: number;
    first_delivered_at: Date | null;
    last_delivered_at: Date | null;
    last_error_code: string | null;
    legacy_attempts: number;
    payload_purged_at: Date | null;
    created_at: Date;
    updated_at: Date;
}
export interface MessageAttemptRow extends RowDataPacket {
    id: string;
    delivery_id: string;
    attempt_no: number;
    send_cycle: number;
    status: "prepared" | "submitted" | "succeeded" | "failed" | "unknown";
    channel_version_id: string;
    endpoint_fingerprint: string;
    payload_hash: string;
    fence_token: string;
    submitted_at: Date | null;
    completed_at: Date | null;
    response_status: number | null;
    response_summary: string | null;
    error_code: string | null;
    retry_after_seconds: number | null;
    uncertain: number;
    created_at: Date;
}
export interface DeliveryWrite {
    auditReason?:string;
    actor: MessageWrite["actor"];
    authorize: (conn: PoolConnection, row: MessageDeliveryRow, channel: MessageChannelRow) => Promise<void>;
}
export interface ClaimedMessage {
    delivery: MessageDeliveryRow;
    channel: MessageChannelRow;
    version: ChannelVersionRow;
    attempt: MessageAttemptRow;
}
const all: QueryFilter = { allow: [{ type: "all" }], deny: [], ceiling: { type: "all" } };
const deliverySelect = "e.*,CAST(e.fence_token AS CHAR) fence_token,CAST(e.authorized_epoch AS CHAR) authorized_epoch";
async function delivery(id: string, filter: QueryFilter, conn?: PoolConnection, lock = false) { const access = jobFilterSql(filter, "execution"); return one<MessageDeliveryRow>(`SELECT ${deliverySelect} FROM message_deliveries e WHERE e.id=? AND ${access.sql}${lock ? " FOR UPDATE" : ""}`, [id, ...access.params], conn); }
async function lockChannel(id: string, conn: PoolConnection) { const row = await one<MessageChannelRow>("SELECT *,CAST(dispatch_epoch AS CHAR) dispatch_epoch FROM message_channels WHERE id=? FOR UPDATE", [id], conn); if (!row)
    throw new ForgeError("MSG-7201"); return row; }
function revision(row: MessageDeliveryRow, expected: number) { if (row.state_revision !== expected || row.state_revision >= MAX_REVISION)
    throw new ForgeError("MSG-7206"); }
async function idempotent<T>(conn: PoolConnection, rawScope: string, keyValue: string, request: unknown, fn: () => Promise<T>): Promise<T> {
    const parsed = JOB_IDEMPOTENCY_KEY_SCHEMA.safeParse(keyValue);
    if (!parsed.success)
        throw new ForgeError("CFG-8501");
    const scope = sha256(rawScope), key = sha256(parsed.data), hash = sha256(JSON.stringify(request));
    const cached = await one<{
        request_hash: string;
        response_json: T;
    }>("SELECT request_hash,response_json FROM idempotency_keys WHERE scope=? AND idempotency_key=? AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE", [scope, key], conn);
    if (cached) {
        if (cached.request_hash !== hash)
            throw new ForgeError("MSG-7206");
        return cached.response_json;
    }
    const result = await fn();
    await conn.execute("DELETE FROM idempotency_keys WHERE scope=? AND idempotency_key=? AND expires_at<=UTC_TIMESTAMP(3)", [scope, key]);
    await conn.execute("INSERT INTO idempotency_keys(id,scope,idempotency_key,request_hash,status_code,response_json,expires_at) VALUES(?,?,?,?,202,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 24 HOUR))", [newId(), scope, key, hash, JSON.stringify(result)]);
    return result;
}
async function audit(conn: PoolConnection, actor: DeliveryWrite["actor"], row: MessageDeliveryRow, action: string, details: unknown) { await auditRepo.audit({ actorType: actor.type, actorId: actor.id, action, resourceType: "message_delivery", resourceId: row.id, orgUnitId: row.owner_org_unit_id, details }, conn); }
async function hold(conn: PoolConnection, id: string, reason: string) { await conn.execute("UPDATE message_deliveries SET status='held',hold_reason=?,claimed_by=NULL,lease_expires_at=NULL,next_attempt_at=NULL,state_revision=state_revision+1 WHERE id=?", [reason, id]); }
async function duplicateRisk(id: string, filter: QueryFilter, conn?: PoolConnection): Promise<boolean> { const access = jobFilterSql(filter, "execution"); const row = await one<{
    risk: number;
}>(`SELECT (e.status='unknown' OR e.first_delivered_at IS NOT NULL OR EXISTS(SELECT 1 FROM message_delivery_attempts a WHERE a.delivery_id=e.id AND (a.status IN ('unknown','succeeded') OR a.uncertain=1))) risk FROM message_deliveries e WHERE e.id=? AND ${access.sql}`, [id, ...access.params], conn); return !!row?.risk; }
export const messageDeliveryRepo = {
    duplicateRisk,
    getDelivery: delivery,
    async listDeliveries(filter: QueryFilter, input: {
        limit?: number;
        cursor?: string;
        channelId?: string;
        status?: MessageStatus;
        eventType?: string;
        sourceType?: string;
        sourceId?: string;
        from?: string;
        to?: string;
        createdFrom?:string;
        createdBefore?:string;
    } = {}) {
        const limit = input.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new ForgeError("CFG-8501");
        const from=input.createdFrom??input.from,to=input.createdBefore??input.to;
        const access = jobFilterSql(filter, "execution"), context = sha256(JSON.stringify({ filter, ...input, from:from?new Date(from).toISOString():undefined,to:to?new Date(to).toISOString():undefined,createdFrom:undefined,createdBefore:undefined,cursor: undefined, limit: undefined })), cursor = readBoundPageCursor(input.cursor, context), clauses = [access.sql], params: unknown[] = [...access.params];
        for (const [field, value] of Object.entries({ channel_id: input.channelId, status: input.status, event_type: input.eventType, source_type: input.sourceType, source_id: input.sourceId }))
            if (value !== undefined) {
                clauses.push(`e.${field}=?`);
                params.push(value);
            }
        if (from) {
            clauses.push("e.created_at>=?");
            params.push(new Date(from));
        }
        if (to) {
            clauses.push("e.created_at<?");
            params.push(new Date(to));
        }
        if (cursor) {
            clauses.push("(e.created_at<? OR (e.created_at=? AND e.id<?))");
            params.push(new Date(cursor.createdAt), new Date(cursor.createdAt), cursor.id);
        }
        const rows = await query<MessageDeliveryRow>(`SELECT ${deliverySelect.replace("e.*", "e.id,e.event_id,e.event_type,e.source_type,e.source_id,e.source_generation,e.owner_org_unit_id,e.subject_type,e.subject_id,e.app_id,e.channel_id,e.channel_version_id,e.status,e.hold_reason,e.state_revision,e.send_cycle,e.total_attempts,e.next_attempt_at,e.first_delivered_at,e.last_delivered_at,e.last_error_code,e.created_at")} FROM message_deliveries e WHERE ${clauses.map(clause => `(${clause})`).join(" AND ")} ORDER BY e.created_at DESC,e.id DESC LIMIT ?`, [...params, limit + 1]);
        const items = rows.slice(0, limit), last = items.at(-1);
        return { items, nextCursor: rows.length > limit && last ? boundPageCursor({ createdAt: last.created_at.toISOString(), id: last.id }, context) : null };
    },
    async listAttempts(id: string, filter: QueryFilter, input: {
        limit?: number;
        cursor?: string;
    } = {}) {
        const limit = input.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new ForgeError("CFG-8501");
        const access = jobFilterSql(filter, "execution"), context = sha256(JSON.stringify({ filter, id, kind: "message_attempts" })), cursor = readBoundPageCursor(input.cursor, context);
        const rows = await query<MessageAttemptRow>(`SELECT a.*,CAST(a.fence_token AS CHAR) fence_token FROM message_delivery_attempts a JOIN message_deliveries e ON e.id=a.delivery_id WHERE e.id=? AND ${access.sql}${cursor ? " AND (a.created_at<? OR (a.created_at=? AND a.id<?))" : ""} ORDER BY a.created_at DESC,a.id DESC LIMIT ?`, [id, ...access.params, ...(cursor ? [new Date(cursor.createdAt), new Date(cursor.createdAt), cursor.id] : []), limit + 1]);
        const items = rows.slice(0, limit), last = items.at(-1);
        return { items, nextCursor: rows.length > limit && last ? boundPageCursor({ createdAt: last.created_at.toISOString(), id: last.id }, context) : null };
    },
    async enqueueTest(input: {
        channelId: string;
        expectedRevision: number;
        idempotencyKey: string;
        eventType: "test.webhook" | "test.wecom";
        templateVersionId?: string;
    }, filter: QueryFilter, options: MessageWrite, body: (channel: MessageChannelRow, version: ChannelVersionRow, conn: PoolConnection, eventId: string) => Promise<string>) {
        return transaction(async (conn) => {
            const channel = await messageConfigRepo.getMessageChannel(input.channelId, filter, conn, true);
            if (!channel)
                throw new ForgeError("MSG-7201");
            await options.authorize(conn, channel);
            return idempotent(conn, `message-test:${options.actor.type}:${options.actor.id}:${input.channelId}`, input.idempotencyKey, { channelId: input.channelId, revision: input.expectedRevision, eventType: input.eventType, templateVersionId: input.templateVersionId ?? null }, async () => {
                if (channel.revision !== input.expectedRevision)
                    throw new ForgeError("MSG-7206");
                if (channel.status !== "active")
                    throw new ForgeError("MSG-7202");
                if (input.eventType !== `test.${channel.type}`)
                    throw new ForgeError("CFG-8501");
                const version = await messageConfigRepo.getChannelVersion(channel.published_version_id, channel.id, filter, conn);
                if (!version)
                    throw new ForgeError("MSG-7201");
                const id = newId(), payload = await body(channel, version, conn, `test_${id}`);
                await conn.execute("INSERT INTO message_deliveries(id,event_id,event_type,source_type,source_id,owner_org_unit_id,subject_type,subject_id,channel_id,channel_version_id,matched_rules_json,template_version_id,payload_body,payload_hash,next_attempt_at) VALUES (?,?,?,'test',?,?,?,?,?,?,'[]',?,?,?,UTC_TIMESTAMP(3))", [id, `test_${id}`, input.eventType, channel.id, channel.owner_org_unit_id, options.actor.type, options.actor.id, channel.id, version.id, input.templateVersionId ?? null, Buffer.from(payload, "utf8"), sha256(payload)]);
                await audit(conn, options.actor, (await delivery(id, all, conn))!, "message.test", { channelId: channel.id });
                return { deliveryId: id, statusUrl: `/admin/api/message-deliveries/${id}` };
            });
        }, "READ COMMITTED");
    },
    async control(id: string, action: "retry" | "cancel", input: MessageRetry, expected: number, key: string, filter: QueryFilter, options: DeliveryWrite) {
        return transaction(async (conn) => {
            const initial = await delivery(id, filter, conn);
            if (!initial)
                throw new ForgeError("MSG-7201");
            const channel = await lockChannel(initial.channel_id, conn), row = await delivery(id, filter, conn, true);
            if (!row)
                throw new ForgeError("MSG-7201");
            await options.authorize(conn, row, channel);
            return idempotent(conn, `message-${action}:${options.actor.type}:${options.actor.id}:${id}`, key, { id, expected, ...input }, async () => {
                revision(row, expected);
                if (action === "retry") {
                    if (row.status === "sending" || row.status === "queued" || row.status === "retry_wait")
                        throw new ForgeError("MSG-7206");
                    if (!row.payload_body)
                        throw new ForgeError("MSG-7203");
                    if (channel.type === "wecom" && !validWecomPayload(row.payload_body.toString("utf8")))
                        throw new ForgeError("MSG-7206", { message: "该消息未通过模板渲染校验，不能补发" });
                    if (channel.status !== "active")
                        throw new ForgeError("MSG-7202");
                    if (await duplicateRisk(row.id, filter, conn) && !input.acknowledgeDuplicate)
                        throw new ForgeError("MSG-7206", { message: "请确认消息可能重复送达" });
                    const historical = channel.published_version_id !== row.channel_version_id;
                    if (historical && !input.acknowledgeHistoricalTarget)
                        throw new ForgeError("MSG-7202");
                    await conn.execute("UPDATE message_deliveries SET status='queued',hold_reason=NULL,cancel_requested=0,send_cycle=send_cycle+1,cycle_attempts=0,state_revision=state_revision+1,historical_target_ack=?,fence_token=fence_token+1,claimed_by=NULL,lease_expires_at=NULL,next_attempt_at=UTC_TIMESTAMP(3) WHERE id=?", [historical ? 1 : 0, id]);
                }
                else {
                    if (!["queued", "sending", "retry_wait", "held", "unknown"].includes(row.status))
                        throw new ForgeError("MSG-7206");
                    await conn.execute("UPDATE message_deliveries SET cancel_requested=1,status=IF(status='sending','sending','cancelled'),hold_reason=NULL,next_attempt_at=NULL,state_revision=state_revision+1 WHERE id=?", [id]);
                }
                await audit(conn, options.actor, row, `message.${action}`, { reason: options.auditReason??"***",reasonHash:sha256(input.reason), ...(action === "retry" ? { acknowledgeDuplicate: input.acknowledgeDuplicate === true, acknowledgeHistoricalTarget: input.acknowledgeHistoricalTarget === true } : {}) });
                const updated = (await delivery(id, all, conn))!;
                return { deliveryId: id, sendCycle: updated.send_cycle, status: updated.status, stateRevision: updated.state_revision };
            });
        }, "READ COMMITTED");
    },
    async due(limit = 20) { return query<{
        id: string;
        channel_id: string;
    }>("SELECT id,channel_id FROM message_deliveries WHERE (status IN ('queued','retry_wait') AND next_attempt_at<=UTC_TIMESTAMP(3)) OR (status='sending' AND lease_expires_at<=UTC_TIMESTAMP(3)) ORDER BY next_attempt_at,id LIMIT ?", [limit]); },
    async prepare(id: string, channelId: string, workerId: string, authorize: (row: MessageDeliveryRow, channel: MessageChannelRow, conn: PoolConnection) => Promise<boolean>): Promise<ClaimedMessage | null> {
        return transaction(async (conn) => {
            const channel = await lockChannel(channelId, conn), row = await delivery(id, all, conn, true);
            if (!row || row.channel_id !== channel.id || !["queued", "retry_wait"].includes(row.status) || !row.next_attempt_at || row.next_attempt_at > new Date())
                return null;
            if (channel.status !== "active") {
                await hold(conn, id, "channel_disabled");
                return null;
            }
            if (channel.published_version_id !== row.channel_version_id && !row.historical_target_ack) {
                await hold(conn, id, "target_changed");
                return null;
            }
            if (row.cancel_requested) {
                await conn.execute("UPDATE message_deliveries SET status='cancelled',next_attempt_at=NULL,state_revision=state_revision+1 WHERE id=?", [id]);
                return null;
            }
            if (!row.payload_body) {
                await conn.execute("UPDATE message_deliveries SET status='failed',next_attempt_at=NULL,last_error_code='MSG-7203',state_revision=state_revision+1 WHERE id=?", [id]);
                return null;
            }
            if (channel.type === "wecom" && !validWecomPayload(row.payload_body.toString("utf8"))) {
                await conn.execute("UPDATE message_deliveries SET status='failed',next_attempt_at=NULL,last_error_code='MSG-7204',state_revision=state_revision+1 WHERE id=?", [id]);
                return null;
            }
            if (!await authorize(row, channel, conn)) {
                await hold(conn, id, "credential_unavailable");
                return null;
            }
            const version = await messageConfigRepo.getChannelVersion(row.channel_version_id, channel.id, all, conn);
            if (!version) {
                await hold(conn, id, "target_changed");
                return null;
            }
            if (row.cycle_attempts >= 6) {
                await conn.execute("UPDATE message_deliveries SET status='failed',next_attempt_at=NULL,state_revision=state_revision+1 WHERE id=?", [id]);
                return null;
            }
            await conn.execute("UPDATE message_deliveries SET status='sending',total_attempts=total_attempts+1,cycle_attempts=cycle_attempts+1,claimed_by=?,lease_expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 SECOND),fence_token=fence_token+1,authorized_epoch=?,state_revision=state_revision+1 WHERE id=?", [workerId, channel.dispatch_epoch, id]);
            const claimed = (await delivery(id, all, conn))!, attemptId = newId();
            await conn.execute("INSERT INTO message_delivery_attempts(id,delivery_id,attempt_no,send_cycle,channel_version_id,endpoint_fingerprint,payload_hash,fence_token) VALUES(?,?,?,?,?,?,?,?)", [attemptId, id, claimed.total_attempts, claimed.send_cycle, version.id, version.endpoint_fingerprint, row.payload_hash, claimed.fence_token]);
            const attempt = (await one<MessageAttemptRow>("SELECT *,CAST(fence_token AS CHAR) fence_token FROM message_delivery_attempts WHERE id=?", [attemptId], conn))!;
            return { delivery: claimed, channel, version, attempt };
        }, "READ COMMITTED");
    },
    async submit(claim: ClaimedMessage, authorize: (row: MessageDeliveryRow, channel: MessageChannelRow, conn: PoolConnection) => Promise<boolean>,throttleKey:string|null): Promise<boolean> {
        return transaction(async (conn) => {
            const channel = await lockChannel(claim.channel.id, conn), row = await delivery(claim.delivery.id, all, conn, true);
            if (!row || row.status !== "sending" || row.fence_token !== claim.delivery.fence_token || row.send_cycle !== claim.delivery.send_cycle || !row.lease_expires_at || row.lease_expires_at <= new Date())
                return false;
            if (channel.status !== "active" || channel.dispatch_epoch !== row.authorized_epoch || row.cancel_requested) {
                await conn.execute("UPDATE message_delivery_attempts SET status='failed',completed_at=UTC_TIMESTAMP(3),error_code='MSG-7202' WHERE id=? AND status='prepared'", [claim.attempt.id]);
                if (row.cancel_requested)
                    await conn.execute("UPDATE message_deliveries SET status='cancelled',next_attempt_at=NULL,claimed_by=NULL,lease_expires_at=NULL,state_revision=state_revision+1 WHERE id=?", [row.id]);
                else
                    await hold(conn, row.id, channel.status !== "active" ? "channel_disabled" : "target_changed");
                return false;
            }
            if (!await authorize(row, channel, conn)) {
                await conn.execute("UPDATE message_delivery_attempts SET status='failed',completed_at=UTC_TIMESTAMP(3),error_code='MSG-7202' WHERE id=? AND status='prepared'",[claim.attempt.id]);
                await hold(conn,row.id,"credential_unavailable");
                return false;
            }
            if (channel.type === "wecom") {
                if(!throttleKey||!/^[a-f0-9]{64}$/.test(throttleKey))throw new ForgeError("MSG-7206");
                const key = `message-throttle:${throttleKey}`;
                await conn.execute("INSERT IGNORE INTO settings (`key`,value_json) VALUES (?,'[]')", [key]);
                const rate = (await one<{
                    value_json: number[];
                }>("SELECT value_json FROM settings WHERE `key`=? FOR UPDATE", [key], conn))!;
                const now = Date.now(), timestamps = Array.isArray(rate.value_json) ? rate.value_json.filter(time => typeof time === "number" && time > now - 60000) : [];
                if (timestamps.length >= 20) {
                    await conn.execute("UPDATE message_delivery_attempts SET status='failed',completed_at=UTC_TIMESTAMP(3),error_code='MSG-7204',response_summary='本地渠道节流，未派发' WHERE id=? AND status='prepared'", [claim.attempt.id]);
                    await conn.execute("UPDATE message_deliveries SET status='retry_wait',cycle_attempts=cycle_attempts-1,claimed_by=NULL,lease_expires_at=NULL,next_attempt_at=?,state_revision=state_revision+1 WHERE id=?", [new Date(Math.min(...timestamps) + 60001), row.id]);
                    return false;
                }
                await conn.execute("UPDATE settings SET value_json=?,revision=revision+1 WHERE `key`=?", [JSON.stringify([...timestamps, now]), key]);
            }
            const [result] = await conn.execute<{
                affectedRows: number;
            } & import("mysql2").ResultSetHeader>("UPDATE message_delivery_attempts SET status='submitted',submitted_at=UTC_TIMESTAMP(3) WHERE id=? AND status='prepared'", [claim.attempt.id]);
            return result.affectedRows === 1;
        }, "READ COMMITTED");
    },
    async complete(claim: ClaimedMessage, outcome: {
        attemptStatus: "succeeded" | "failed" | "unknown";
        deliveryStatus: "delivered" | "failed" | "unknown" | "retry_wait";
        errorCode: string | null;
        responseSummary: string | null;
        retryDelayMs: number | null;
    }, httpStatus: number | null, credentialUnavailable = false) {
        await transaction(async (conn) => {
            const channel = await lockChannel(claim.channel.id, conn), row = await delivery(claim.delivery.id, all, conn, true);
            if (!row)
                return;
            const attempt = await one<MessageAttemptRow>("SELECT *,CAST(fence_token AS CHAR) fence_token FROM message_delivery_attempts WHERE id=? FOR UPDATE", [claim.attempt.id], conn);
            if (!attempt || (attempt.completed_at && !(attempt.status === "unknown" && outcome.attemptStatus !== "unknown")))
                return;
            await conn.execute("UPDATE message_delivery_attempts SET status=?,completed_at=UTC_TIMESTAMP(3),response_status=?,response_summary=?,error_code=?,retry_after_seconds=?,uncertain=? WHERE id=?", [outcome.attemptStatus, httpStatus, outcome.responseSummary, outcome.errorCode, outcome.retryDelayMs === null ? null : Math.ceil(outcome.retryDelayMs / 1000), outcome.attemptStatus === "unknown" ? 1 : 0, attempt.id]);
            if (attempt.completed_at || row.status !== "sending" || row.fence_token !== claim.delivery.fence_token || row.send_cycle !== claim.delivery.send_cycle)
                return;
            let status: string = outcome.deliveryStatus, holdReason: string | null = null;
            if (credentialUnavailable) {
                status = "held";
                holdReason = "credential_unavailable";
            }
            else if (row.cancel_requested && status === "retry_wait")
                status = "cancelled";
            else if (status === "retry_wait" && (channel.status !== "active" || channel.dispatch_epoch !== row.authorized_epoch)) {
                status = "held";
                holdReason = channel.published_version_id !== row.channel_version_id ? "target_changed" : "channel_disabled";
            }
            await conn.execute("UPDATE message_deliveries SET status=?,hold_reason=?,last_error_code=?,next_attempt_at=?,claimed_by=NULL,lease_expires_at=NULL,state_revision=state_revision+1,first_delivered_at=IF(?='delivered',COALESCE(first_delivered_at,UTC_TIMESTAMP(3)),first_delivered_at),last_delivered_at=IF(?='delivered',UTC_TIMESTAMP(3),last_delivered_at) WHERE id=?", [status, holdReason, outcome.errorCode, status === "retry_wait" && outcome.retryDelayMs !== null ? new Date(Date.now() + outcome.retryDelayMs) : null, status, status, row.id]);
        }, "READ COMMITTED");
    },
    async expiredClaim(id: string, channelId: string): Promise<ClaimedMessage | null> {
        return transaction(async (conn) => { const channel = await lockChannel(channelId, conn), row = await delivery(id, all, conn, true); if (!row || row.status !== "sending" || !row.lease_expires_at || row.lease_expires_at > new Date())
            return null; const attempt = await one<MessageAttemptRow>("SELECT *,CAST(fence_token AS CHAR) fence_token FROM message_delivery_attempts WHERE delivery_id=? AND attempt_no=?", [id, row.total_attempts], conn), version = await messageConfigRepo.getChannelVersion(row.channel_version_id, channelId, all, conn); return attempt && version ? { delivery: row, channel, version, attempt } : null; }, "READ COMMITTED");
    },
};
