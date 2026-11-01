import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { ForgeError, MAX_REVISION, newId, sha256, type QueryFilter } from "@forge/core";
import { MESSAGE_CHANNEL_CREATE_SCHEMA, MESSAGE_CHANNEL_PATCH_SCHEMA, MESSAGE_ENDPOINT_INPUT_SCHEMA,wecomTargetIdentity, type MessageChannelCreate, type MessageChannelPatch } from "@forge/contracts";
import { one, query, transaction } from "../db.js";
import { jobFilterSql } from "../job-filter.js";
import { boundPageCursor, readBoundPageCursor } from "../pagination.js";
import { secretsRepo, type CredentialResource } from "./secrets.js";
import { auditRepo } from "./audit.js";
export interface MessageChannelRow extends RowDataPacket {
    id: string;
    key: string;
    name: string;
    description: string;
    type: "webhook" | "wecom";
    status: string;
    owner_org_unit_id: string | null;
    created_by: string | null;
    revision: number;
    published_version_id: string;
    next_version: number;
    dispatch_epoch: string;
    legacy_app_id: string | null;
    credential_owner_type: "message_channel" | "api_app";
    credential_owner_id: string;
    created_at: Date;
    updated_at: Date;
}
export interface ChannelVersionRow extends RowDataPacket {
    id: string;
    channel_id: string;
    version: number;
    endpoint_secret_id: string;
    signing_secret_id: string | null;
    header_refs_json: Record<string, string>;
    endpoint_fingerprint: string;
    transport_json: Record<string, unknown>;
    mentioned_ids_json: string[];
    mentioned_mobiles_json: string[];
    created_at: Date;
}
export interface MessageWrite {
    actor: {
        type: "user" | "service";
        id: string;
    };
    authorize: (conn: PoolConnection, row: MessageChannelRow | null) => Promise<void>;
}
async function channel(id: string, filter: QueryFilter, conn?: PoolConnection, lock = false): Promise<MessageChannelRow | null> {
    const access = jobFilterSql(filter, "definition");
    return one<MessageChannelRow>(`SELECT d.*,CAST(d.dispatch_epoch AS CHAR) dispatch_epoch FROM message_channels d WHERE d.id=? AND d.status<>'deleted' AND ${access.sql}${lock ? " FOR UPDATE" : ""}`, [id, ...access.params], conn);
}
async function version(id: string, conn: PoolConnection): Promise<ChannelVersionRow> { const row = await one<ChannelVersionRow>("SELECT * FROM message_channel_versions WHERE id=?", [id], conn); if (!row)
    throw new ForgeError("MSG-7201"); return row; }
function resource(row: MessageChannelRow): CredentialResource { return { type: row.credential_owner_type, id: row.credential_owner_id, orgUnitId: row.owner_org_unit_id, name: row.name, createdBy: row.created_by }; }
function revision(row: MessageChannelRow, expected: number) { if (row.revision !== expected || row.revision >= MAX_REVISION)
    throw new ForgeError("MSG-7206"); }
async function bindValue(conn: PoolConnection, row: MessageChannelRow, slot: string, input: {
    value: string;
} | {
    secretId: string;
}, actorId: string): Promise<string> {
    const target = resource(row);
    let id: string;
    if ("value" in input)
        id = (await secretsRepo.createSecret({ key: `message-${newId().toLowerCase()}`, name: `${Array.from(row.name).slice(0, 80).join("")} / ${slot.startsWith("endpoint") ? "地址" : slot}`, scope: { type: "resource", resourceType: target.type, id: target.id }, orgUnitId: target.orgUnitId, value: input.value, createdBy: actorId }, undefined, conn)).id;
    else
        id = input.secretId;
    await secretsRepo.bindSecretReferences(target, { [slot]: id }, conn);
    return id;
}
async function endpointSnapshot(conn: PoolConnection, row: MessageChannelRow, versionId: string, input: MessageChannelCreate["endpoint"], actorId: string): Promise<{
    id: string;
    fingerprint: string;
}> {
    let value: string;
    if ("value" in input)
        value = input.value;
    else {
        const slot = `endpoint-source:${versionId}`, target = resource(row);
        await secretsRepo.bindSecretReferences(target, { [slot]: input.secretId }, conn);
        value = (await secretsRepo.resolveCredentialValues(target.type, target.id, { [slot]: input.secretId }, conn))[slot]!;
        const refs = await query<{
            id: string;
        }>("SELECT id FROM resource_references WHERE from_type=? AND from_id=? AND binding_key=?", [target.type, target.id, slot], conn);
        for (const ref of refs)
            await conn.execute("DELETE FROM resource_references WHERE id=?", [ref.id]);
    }
    if (!MESSAGE_ENDPOINT_INPUT_SCHEMA.safeParse({ value }).success||(row.type==="wecom"&&!wecomTargetIdentity(value)))
        throw new ForgeError("MSG-7206", { message: "目标地址无效",details:{fields:[{path:"endpoint",issue:"目标地址无效或缺少唯一的机器人 key 参数"}]} });
    const id = await bindValue(conn, row, `endpoint-version:${versionId}`, { value }, actorId);
    return { id, fingerprint: sha256(value) };
}
async function createVersion(conn: PoolConnection, row: MessageChannelRow, input: MessageChannelPatch, actorId: string, previous?: ChannelVersionRow): Promise<string> {
    const id = newId();
    const existing = [...(input.endpoint && "secretId" in input.endpoint ? [input.endpoint.secretId] : []), ...(previous ? [previous.endpoint_secret_id] : []), ...(input.signingSecret && "secretId" in input.signingSecret ? [input.signingSecret.secretId] : previous?.signing_secret_id ? [previous.signing_secret_id] : []), ...Object.values(input.headerSecretRefs ?? previous?.header_refs_json ?? {})];
    // Bindings take row locks; acquire their complete existing set in one order across channels.
    if (existing.length)
        await conn.query(`SELECT id FROM secrets WHERE id IN (${[...new Set(existing)].map(() => "?").join(",")}) ORDER BY id FOR UPDATE`, [...new Set(existing)].sort());
    const endpoint = input.endpoint ? await endpointSnapshot(conn, row, id, input.endpoint, actorId) : { id: previous!.endpoint_secret_id, fingerprint: previous!.endpoint_fingerprint };
    await secretsRepo.bindSecretReferences(resource(row), { [`endpoint-version:${id}`]: endpoint.id }, conn);
    let signing = previous?.signing_secret_id ?? null;
    if (input.signingSecret)
        signing = await bindValue(conn, row, `signing:${id}`, input.signingSecret, actorId);
    if (row.type === "webhook" && !signing)
        throw new ForgeError("MSG-7206", { message: "Webhook需要签名凭据" });
    if (row.type === "wecom" && input.signingSecret !== undefined)
        throw new ForgeError("MSG-7206", { message: "企业微信渠道不使用签名凭据" });
    const headers = input.headerSecretRefs ?? previous?.header_refs_json ?? {};
    const bindings = Object.fromEntries(Object.entries(headers).map(([name, value]) => [`header:${id}:${name.toLowerCase()}`, value]));
    if (signing)
        bindings[`signing:${id}`] = signing;
    await secretsRepo.bindSecretReferences(resource(row), bindings, conn);
    await conn.execute("UPDATE resource_references SET from_version_id=? WHERE from_type=? AND from_id=? AND (binding_key=? OR binding_key=? OR binding_key LIKE ?)", [id, row.credential_owner_type, row.credential_owner_id, `endpoint-version:${id}`, `signing:${id}`, `header:${id}:%`]);
    await conn.execute("INSERT INTO message_channel_versions (id,channel_id,version,endpoint_secret_id,signing_secret_id,header_refs_json,endpoint_fingerprint,transport_json,mentioned_ids_json,mentioned_mobiles_json,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [id, row.id, row.next_version, endpoint.id, signing, JSON.stringify(headers), endpoint.fingerprint, JSON.stringify({ timeoutMs: 10000, maxAttempts: 6 }), JSON.stringify(input.mentionedIds ?? previous?.mentioned_ids_json ?? []), JSON.stringify(input.mentionedMobiles ?? previous?.mentioned_mobiles_json ?? []), actorId]);
    await conn.execute("UPDATE message_channels SET published_version_id=?,next_version=next_version+1 WHERE id=?", [id, row.id]);
    return id;
}
function auditMetadata(row:MessageChannelRow){return{revision:row.revision,status:row.status,versionId:row.published_version_id,nameHash:sha256(row.name),descriptionHash:sha256(row.description)};}
async function audit(conn: PoolConnection, options: MessageWrite, row: MessageChannelRow, action: string) {
 const after=await one<MessageChannelRow>("SELECT * FROM message_channels WHERE id=?",[row.id],conn);
 await auditRepo.audit({actorType:options.actor.type,actorId:options.actor.id,action,resourceType:"message_channel",resourceId:row.id,orgUnitId:row.owner_org_unit_id,details:{before:action.endsWith(".create")?null:auditMetadata(row),after:after?auditMetadata(after):null}},conn);
}

export const messageConfigRepo = {
    getMessageChannel: channel,
    async channelSummaries(ids: string[], filter: QueryFilter) {
        if (!ids.length)
            return [];
        const access = jobFilterSql(filter, "definition");
        return query<ChannelVersionRow & {
            reference_count: number;
        }>(`SELECT v.*,(SELECT COUNT(*) FROM message_rules r WHERE r.channel_id=d.id AND r.status<>'deleted')+(SELECT COUNT(*) FROM message_deliveries m WHERE m.channel_id=d.id) reference_count FROM message_channels d JOIN message_channel_versions v ON v.id=d.published_version_id AND v.channel_id=d.id WHERE d.id IN (${ids.map(() => "?").join(",")}) AND d.status<>'deleted' AND ${access.sql}`, [...ids, ...access.params]);
    },
    async manageableChannelIds(ids: string[], filter: QueryFilter): Promise<string[]> { if (!ids.length)
        return []; const access = jobFilterSql(filter, "definition"); return (await query<{
        id: string;
    }>(`SELECT d.id FROM message_channels d WHERE d.id IN (${ids.map(() => "?").join(",")}) AND d.status<>'deleted' AND ${access.sql}`, [...ids, ...access.params])).map(row => row.id); },
    async listChannelVersions(channelId: string, filter: QueryFilter, input: {
        limit?: number;
        cursor?: string;
    } = {}) {
        const limit = input.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new ForgeError("CFG-8501");
        const access = jobFilterSql(filter, "definition"), context = sha256(JSON.stringify({ filter, channelId, kind: "channel_versions" })), cursor = readBoundPageCursor(input.cursor, context);
        const rows = await query<ChannelVersionRow>(`SELECT v.* FROM message_channel_versions v JOIN message_channels d ON d.id=v.channel_id WHERE d.id=? AND d.status<>'deleted' AND ${access.sql}${cursor ? " AND (v.created_at<? OR (v.created_at=? AND v.id<?))" : ""} ORDER BY v.created_at DESC,v.id DESC LIMIT ?`, [channelId, ...access.params, ...(cursor ? [new Date(cursor.createdAt), new Date(cursor.createdAt), cursor.id] : []), limit + 1]);
        const items = rows.slice(0, limit), last = items.at(-1);
        return { items, nextCursor: rows.length > limit && last ? boundPageCursor({ createdAt: last.created_at.toISOString(), id: last.id }, context) : null };
    },
    async getChannelVersion(id: string, channelId: string, filter: QueryFilter, conn?: PoolConnection) { const access = jobFilterSql(filter, "definition"); return one<ChannelVersionRow>(`SELECT v.* FROM message_channel_versions v JOIN message_channels d ON d.id=v.channel_id WHERE v.id=? AND d.id=? AND d.status<>'deleted' AND ${access.sql}`, [id, channelId, ...access.params], conn); },
    async listMessageChannels(filter: QueryFilter, input: {
        limit?: number;
        cursor?: string;
        status?: string;
    } = {}) {
        const limit = input.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new ForgeError("CFG-8501");
        const context = sha256(JSON.stringify({ filter, status: input.status ?? null, kind: "message_channels" })), cursor = readBoundPageCursor(input.cursor, context), access = jobFilterSql(filter, "definition");
        const rows = await query<MessageChannelRow>(`SELECT d.*,CAST(d.dispatch_epoch AS CHAR) dispatch_epoch FROM message_channels d WHERE d.status<>'deleted' AND ${access.sql}${input.status ? " AND d.status=?" : ""}${cursor ? " AND (d.created_at<? OR (d.created_at=? AND d.id<?))" : ""} ORDER BY d.created_at DESC,d.id DESC LIMIT ?`, [...access.params, ...(input.status ? [input.status] : []), ...(cursor ? [new Date(cursor.createdAt), new Date(cursor.createdAt), cursor.id] : []), limit + 1]);
        const items = rows.slice(0, limit), last = items.at(-1);
        return { items, nextCursor: rows.length > limit && last ? boundPageCursor({ createdAt: last.created_at.toISOString(), id: last.id }, context) : null };
    },
    async createMessageChannel(raw: MessageChannelCreate, filter: QueryFilter, options: MessageWrite): Promise<MessageChannelRow> {
        const parsed = MESSAGE_CHANNEL_CREATE_SCHEMA.safeParse(raw);
        if (!parsed.success)
            throw new ForgeError("CFG-8501");
        const input = parsed.data;
        return transaction(async (conn) => {
            await options.authorize(conn, null);
            const id = newId();
            await conn.execute("INSERT INTO message_channels (id,`key`,name,description,type,owner_org_unit_id,created_by,credential_owner_type,credential_owner_id) VALUES (?,?,?,?,?,?,?,'message_channel',?)", [id, input.key, input.name, input.description ?? "", input.type, input.orgUnitId ?? null, options.actor.id, id]);
            const row = await channel(id, filter, conn);
            if (!row)
                throw new ForgeError("MSG-7201");
            await createVersion(conn, row, input, options.actor.id);
            await audit(conn, options, row, "message_channel.create");
            return (await channel(id, filter, conn))!;
        }, "READ COMMITTED");
    },
    async updateMessageChannel(id: string, raw: MessageChannelPatch, expected: number, filter: QueryFilter, options: MessageWrite): Promise<MessageChannelRow> {
        const parsed = MESSAGE_CHANNEL_PATCH_SCHEMA.safeParse(raw);
        if (!parsed.success)
            throw new ForgeError("CFG-8501");
        const input = parsed.data;
        return transaction(async (conn) => {
            const row = await channel(id, filter, conn, true);
            if (!row)
                throw new ForgeError("MSG-7201");
            if (row.legacy_app_id)
                throw new ForgeError("MSG-7206", { message: "兼容渠道尚未完成统一切换" });
            await options.authorize(conn, row);
            revision(row, expected);
            const changesVersion = [input.endpoint, input.signingSecret, input.headerSecretRefs, input.mentionedIds, input.mentionedMobiles].some(value => value !== undefined);
            const previous = await version(row.published_version_id, conn);
            if (changesVersion)
                await createVersion(conn, row, input, options.actor.id, previous);
            const disabled = input.status === "disabled", hold = disabled ? "channel_disabled" : changesVersion ? "target_changed" : null;
            if (hold)
                await conn.execute("UPDATE message_deliveries SET status='held',hold_reason=?,next_attempt_at=NULL,state_revision=state_revision+1 WHERE channel_id=? AND status IN ('queued','retry_wait')", [hold, id]);
            await conn.execute("UPDATE message_channels SET name=?,description=?,status=?,revision=revision+1,dispatch_epoch=dispatch_epoch+? WHERE id=?", [input.name ?? row.name, input.description ?? row.description, input.status ?? row.status, changesVersion || input.status !== undefined ? 1 : 0, id]);
            await audit(conn, options, row, "message_channel.update");
            return (await channel(id, filter, conn))!;
        }, "READ COMMITTED");
    },
    async deleteMessageChannel(id: string, expected: number, filter: QueryFilter, options: MessageWrite): Promise<void> {
        await transaction(async (conn) => {
            const row = await channel(id, filter, conn, true);
            if (!row)
                throw new ForgeError("MSG-7201");
            await options.authorize(conn, row);
            revision(row, expected);
            const used = await one<{
                count: number;
            }>("SELECT (SELECT COUNT(*) FROM message_rules WHERE channel_id=? AND status<>'deleted')+(SELECT COUNT(*) FROM message_deliveries WHERE channel_id=?)+(SELECT COUNT(*) FROM resource_references WHERE to_type='message_channel' AND to_id=?) count", [id, id, id], conn);
            if (Number(used?.count))
                throw new ForgeError("MSG-7206", { message: "渠道仍被规则或发送记录引用" });
            await conn.execute("UPDATE message_channels SET status='deleted',revision=revision+1,dispatch_epoch=dispatch_epoch+1 WHERE id=?", [id]);
            await audit(conn, options, row, "message_channel.delete");
        }, "READ COMMITTED");
    },
};
