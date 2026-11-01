import type { PoolConnection } from "mysql2/promise";
import { ForgeError, MAX_REVISION, newId, sha256, type QueryFilter } from "@forge/core";
import { MESSAGE_TEMPLATE_SCHEMA, MESSAGE_TEMPLATE_CREATE_SCHEMA, MESSAGE_RULE_CREATE_SCHEMA, MESSAGE_RULE_PATCH_SCHEMA, type MessageTemplateCreate, type MessageTemplatePatch, type MessageTemplate, type MessageRuleCreate, type MessageRulePatch } from "@forge/contracts";
import { one, query, transaction } from "../db.js";
import { jobFilterSql } from "../job-filter.js";
import { boundPageCursor, readBoundPageCursor } from "../pagination.js";
import { auditRepo } from "./audit.js";
import type { MessageWrite } from "./message-config.js";
export interface MessageTemplateRow {
    id: string;
    key: string;
    name: string;
    description: string;
    owner_org_unit_id: string | null;
    created_by: string | null;
    revision: number;
    status: string;
    draft_json: {
        content: string;
        variables: MessageTemplate["variables"];
    };
    published_version_id: string | null;
    next_version: number;
    created_at: Date;
    updated_at: Date;
}
export interface MessageTemplateVersionRow {
    id: string;
    template_id: string;
    version: number;
    format: "wecom_text";
    content: string;
    variables_json: MessageTemplate["variables"];
    content_hash: string;
    created_at: Date;
}
export interface MessageRuleRow {
    id: string;
    key: string;
    name: string;
    owner_org_unit_id: string | null;
    created_by: string | null;
    revision: number;
    status: "active" | "disabled" | "deleted";
    event_type: MessageRuleCreate["eventType"];
    scope_type: MessageRuleCreate["scope"]["type"];
    scope_id: string | null;
    channel_id: string;
    template_version_id: string | null;
    include_nested_runs: number;
    created_at: Date;
    updated_at: Date;
}
export type MessageCatalogKind = "template" | "rule";
export interface CatalogWrite {
    actor: MessageWrite["actor"];
    authorize: (conn: PoolConnection, row: MessageTemplateRow | MessageRuleRow | null) => Promise<void>;
}
const tables = { template: "message_templates", rule: "message_rules" } as const;
async function get<K extends MessageCatalogKind>(kind: K, id: string, filter: QueryFilter, conn?: PoolConnection, lock = false): Promise<(K extends "template" ? MessageTemplateRow : MessageRuleRow) | null> { const access = jobFilterSql(filter, "definition"); return one(`SELECT d.* FROM ${tables[kind]} d WHERE d.id=? AND d.status<>'deleted' AND ${access.sql}${lock ? " FOR UPDATE" : ""}`, [id, ...access.params], conn); }
function revision(row: {
    revision: number;
}, expected: number) { if (row.revision !== expected || row.revision >= MAX_REVISION)
    throw new ForgeError("MSG-7206"); }
function parse<T>(value: {
    success: true;
    data: T;
} | {
    success: false;
}): T { if (!value.success)
    throw new ForgeError("QAL-7301"); return value.data; }
function auditMetadata(row:MessageTemplateRow|MessageRuleRow){
 const base={revision:row.revision,status:row.status,nameHash:sha256(row.name),orgUnitId:row.owner_org_unit_id};
 return "draft_json"in row?{...base,versionId:row.published_version_id,draftHash:sha256(JSON.stringify(row.draft_json))}:{...base,eventType:row.event_type,scopeType:row.scope_type,scopeId:row.scope_id,channelId:row.channel_id,templateVersionId:row.template_version_id,includeNestedRuns:!!row.include_nested_runs};
}
async function audit(conn:PoolConnection,kind:MessageCatalogKind,options:CatalogWrite,row:MessageTemplateRow|MessageRuleRow,action:string,previous?:MessageRuleRow|null){
 const after=await one<MessageTemplateRow|MessageRuleRow>(`SELECT * FROM ${tables[kind]} WHERE id=?`,[row.id],conn);
 await auditRepo.audit({actorType:options.actor.type,actorId:options.actor.id,action:`message_${kind}.${action}`,resourceType:`message_${kind}`,resourceId:row.id,orgUnitId:row.owner_org_unit_id,details:{before:action==="create"?null:auditMetadata(previous??row),after:after?auditMetadata(after):null}},conn);
}

async function lockEvents(conn: PoolConnection, events: string[]) { for (const event of [...new Set(events)].sort()) {
    const key = `message-rules:${event}`;
    await conn.execute("INSERT IGNORE INTO settings (`key`,value_json) VALUES (?,'{}')", [key]);
    await conn.query("SELECT `key` FROM settings WHERE `key`=? FOR UPDATE", [key]);
} }
async function ruleLimits(conn: PoolConnection, row: MessageRuleRow) {
    const duplicate = await one("SELECT id FROM message_rules WHERE id<>? AND status<>'deleted' AND event_type=? AND scope_type=? AND scope_id<=>? AND channel_id=? LIMIT 1", [row.id, row.event_type, row.scope_type, row.scope_id, row.channel_id], conn);
    if (duplicate)
        throw new ForgeError("MSG-7206", { message: "该事件、范围和渠道已有规则" });
    if (row.status !== "active")
        return;
    const orgs = row.owner_org_unit_id ? [{ owner_org_unit_id: row.owner_org_unit_id }] : await query<{
        owner_org_unit_id: string | null;
    }>("SELECT DISTINCT owner_org_unit_id FROM message_rules WHERE event_type=? AND status='active' UNION SELECT NULL", [row.event_type], conn);
    for (const org of orgs) {
        const channels = await query<{
            channel_id: string;
        }>("SELECT DISTINCT channel_id FROM message_rules WHERE event_type=? AND status='active' AND id<>? AND (owner_org_unit_id IS NULL OR owner_org_unit_id<=>?)", [row.event_type, row.id, org.owner_org_unit_id], conn);
        if (new Set([...channels.map(item => item.channel_id), row.channel_id]).size > 100)
            throw new ForgeError("MSG-7206", { message: "同组织同事件最多100个接收渠道" });
    }
}
export const messageCatalogRepo = {
    async ruleTemplateParents(ids: string[]) { if (!ids.length)
        return []; return query<{
        id: string;
        template_id: string;
    }>(`SELECT id,template_id FROM message_template_versions WHERE id IN (${ids.map(() => "?").join(",")})`, ids); },
    getTemplate: (id: string, filter: QueryFilter, conn?: PoolConnection, lock = false) => get("template", id, filter, conn, lock),
    getRule: (id: string, filter: QueryFilter, conn?: PoolConnection, lock = false) => get("rule", id, filter, conn, lock),
    async manageableIds(kind: MessageCatalogKind, ids: string[], filter: QueryFilter) { if (!ids.length)
        return []; const access = jobFilterSql(filter, "definition"); return (await query<{
        id: string;
    }>(`SELECT d.id FROM ${tables[kind]} d WHERE d.id IN (${ids.map(() => "?").join(",")}) AND d.status<>'deleted' AND ${access.sql}`, [...ids, ...access.params])).map(row => row.id); },
    async list<K extends MessageCatalogKind>(kind: K, filter: QueryFilter, input: {
        limit?: number;
        cursor?: string;
        status?: string;
    } = {}) {
        const limit = input.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new ForgeError("CFG-8501");
        const access = jobFilterSql(filter, "definition"), context = sha256(JSON.stringify({ filter, kind, status: input.status ?? null })), cursor = readBoundPageCursor(input.cursor, context);
        const rows = await query<K extends "template" ? MessageTemplateRow : MessageRuleRow>(`SELECT d.* FROM ${tables[kind]} d WHERE d.status<>'deleted' AND ${access.sql}${input.status ? " AND d.status=?" : ""}${cursor ? " AND (d.created_at<? OR (d.created_at=? AND d.id<?))" : ""} ORDER BY d.created_at DESC,d.id DESC LIMIT ?`, [...access.params, ...(input.status ? [input.status] : []), ...(cursor ? [new Date(cursor.createdAt), new Date(cursor.createdAt), cursor.id] : []), limit + 1]);
        const items = rows.slice(0, limit), last = items.at(-1);
        return { items, nextCursor: rows.length > limit && last ? boundPageCursor({ createdAt: last.created_at.toISOString(), id: last.id }, context) : null };
    },
    async getTemplateVersion(id: string, filter: QueryFilter, conn?: PoolConnection) { const access = jobFilterSql(filter, "definition"); return one<MessageTemplateVersionRow>(`SELECT v.* FROM message_template_versions v JOIN message_templates d ON d.id=v.template_id WHERE v.id=? AND d.status<>'deleted' AND ${access.sql}`, [id, ...access.params], conn); },
    async listTemplateVersions(id: string, filter: QueryFilter, input: {
        limit?: number;
        cursor?: string;
    } = {}) {
        const limit = input.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new ForgeError("CFG-8501");
        const access = jobFilterSql(filter, "definition"), context = sha256(JSON.stringify({ filter, id, kind: "template_versions" })), cursor = readBoundPageCursor(input.cursor, context);
        const rows = await query<MessageTemplateVersionRow>(`SELECT v.* FROM message_template_versions v JOIN message_templates d ON d.id=v.template_id WHERE d.id=? AND d.status<>'deleted' AND ${access.sql}${cursor ? " AND (v.created_at<? OR (v.created_at=? AND v.id<?))" : ""} ORDER BY v.created_at DESC,v.id DESC LIMIT ?`, [id, ...access.params, ...(cursor ? [new Date(cursor.createdAt), new Date(cursor.createdAt), cursor.id] : []), limit + 1]);
        const items = rows.slice(0, limit), last = items.at(-1);
        return { items, nextCursor: rows.length > limit && last ? boundPageCursor({ createdAt: last.created_at.toISOString(), id: last.id }, context) : null };
    },
    async createTemplate(raw: MessageTemplateCreate, filter: QueryFilter, options: CatalogWrite) {
        const input = parse(MESSAGE_TEMPLATE_CREATE_SCHEMA.safeParse(raw));
        if (input.status === "active")
            throw new ForgeError("MSG-7206", { message: "请先发布模板" });
        return transaction(async (conn) => { await options.authorize(conn, null); const id = newId(); await conn.execute("INSERT INTO message_templates(id,`key`,name,description,owner_org_unit_id,created_by,draft_json) VALUES(?,?,?,?,?,?,?)", [id, input.key, input.name, input.description ?? "", input.orgUnitId ?? null, options.actor.id, JSON.stringify({ content: input.content, variables: input.variables })]); const row = (await get("template", id, filter, conn))!; if (!row)
            throw new ForgeError("MSG-7201"); await audit(conn, "template", options, row, "create"); return row; }, "READ COMMITTED");
    },
    async updateTemplate(id: string, input: MessageTemplatePatch, expected: number, filter: QueryFilter, options: CatalogWrite) {
        return transaction(async (conn) => {
            const row = await get("template", id, filter, conn, true);
            if (!row)
                throw new ForgeError("MSG-7201");
            await options.authorize(conn, row);
            revision(row, expected);
            const parsed = parse(MESSAGE_TEMPLATE_SCHEMA.safeParse({ key: row.key, name: input.name ?? row.name, description: input.description ?? row.description, content: input.content ?? row.draft_json.content, variables: input.variables ?? row.draft_json.variables, status: input.status ?? row.status }));
            if (parsed.status === "active" && !row.published_version_id)
                throw new ForgeError("MSG-7206", { message: "请先发布模板" });
            await conn.execute("UPDATE message_templates SET name=?,description=?,draft_json=?,status=?,revision=revision+1 WHERE id=?", [parsed.name, parsed.description ?? "", JSON.stringify({ content: parsed.content, variables: parsed.variables }), parsed.status ?? row.status, id]);
            await audit(conn, "template", options, row, "update");
            return (await get("template", id, filter, conn))!;
        }, "READ COMMITTED");
    },
    async publishTemplate(id: string, expected: number, filter: QueryFilter, options: CatalogWrite) {
        return transaction(async (conn) => {
            const row = await get("template", id, filter, conn, true);
            if (!row)
                throw new ForgeError("MSG-7201");
            await options.authorize(conn, row);
            revision(row, expected);
            const parsed = parse(MESSAGE_TEMPLATE_SCHEMA.safeParse({ key: row.key, name: row.name, ...row.draft_json }));
            if (row.next_version >= MAX_REVISION)
                throw new ForgeError("MSG-7206");
            const versionId = newId(), hash = sha256(JSON.stringify({ content: parsed.content, variables: parsed.variables }));
            await conn.execute("INSERT INTO message_template_versions(id,template_id,version,format,content,variables_json,content_hash,created_by) VALUES(?,?,?,'wecom_text',?,?,?,?)", [versionId, id, row.next_version, parsed.content, JSON.stringify(parsed.variables), hash, options.actor.id]);
            await conn.execute("UPDATE message_templates SET published_version_id=?,next_version=next_version+1,revision=revision+1 WHERE id=?", [versionId, id]);
            await audit(conn, "template", options, row, "publish");
            return { versionId, version: row.next_version, revision: row.revision + 1, contentHash: hash };
        }, "READ COMMITTED");
    },
    async saveRule(id: string | null, raw: MessageRuleCreate | MessageRulePatch, expected: number | null, filter: QueryFilter, options: CatalogWrite, validate: (row: MessageRuleRow, conn: PoolConnection) => Promise<string | null>) {
        return transaction(async (conn) => {
            const initial = id ? await get("rule", id, filter, conn) : null;
            if (id && !initial)
                throw new ForgeError("MSG-7201");
            const merged = initial ? { key: initial.key, name: initial.name, eventType: initial.event_type, scope: initial.scope_type === "global" ? { type: "global" } : { type: initial.scope_type, id: initial.scope_id }, channelId: initial.channel_id, templateVersionId: initial.template_version_id, includeNestedRuns: !!initial.include_nested_runs, status: initial.status, ...parse(MESSAGE_RULE_PATCH_SCHEMA.safeParse(raw)) } : raw;
            const input = parse(MESSAGE_RULE_CREATE_SCHEMA.safeParse(merged));
            await lockEvents(conn, [input.eventType, ...(initial ? [initial.event_type] : [])]);
            const previous = id ? await get("rule", id, filter, conn, true) : null;
            if (id) {
                if (!previous)
                    throw new ForgeError("MSG-7201");
                revision(previous, expected!);
            }
            await options.authorize(conn, previous);
            const row: MessageRuleRow = { ...previous, id: id ?? newId(), key: input.key, name: input.name, event_type: input.eventType, scope_type: input.scope.type, scope_id: "id" in input.scope ? input.scope.id : null, channel_id: input.channelId, template_version_id: input.templateVersionId ?? null, include_nested_runs: input.includeNestedRuns ? 1 : 0, status: input.status, revision: previous?.revision ?? 1, owner_org_unit_id: previous?.owner_org_unit_id ?? null, created_by: options.actor.id, created_at: previous?.created_at ?? new Date(), updated_at: new Date() };
            row.owner_org_unit_id = await validate(row, conn);
            await ruleLimits(conn, row);
            if (previous)
                await conn.execute("UPDATE message_rules SET name=?,event_type=?,scope_type=?,scope_id=?,channel_id=?,template_version_id=?,include_nested_runs=?,status=?,owner_org_unit_id=?,revision=revision+1 WHERE id=?", [row.name, row.event_type, row.scope_type, row.scope_id, row.channel_id, row.template_version_id, row.include_nested_runs, row.status, row.owner_org_unit_id, row.id]);
            else
                await conn.execute("INSERT INTO message_rules(id,`key`,name,event_type,scope_type,scope_id,channel_id,template_version_id,include_nested_runs,status,owner_org_unit_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [row.id, row.key, row.name, row.event_type, row.scope_type, row.scope_id, row.channel_id, row.template_version_id, row.include_nested_runs, row.status, row.owner_org_unit_id, options.actor.id]);
            await audit(conn, "rule", options, row, previous ? "update" : "create",previous);
            return (await get("rule", row.id, filter, conn))!;
        }, "READ COMMITTED");
    },
    async remove(kind: MessageCatalogKind, id: string, expected: number, filter: QueryFilter, options: CatalogWrite) {
        await transaction(async (conn) => {
            if (kind === "rule") {
                const initial = await get(kind, id, filter, conn);
                if (!initial)
                    throw new ForgeError("MSG-7201");
                await lockEvents(conn, [(initial as MessageRuleRow).event_type]);
            }
            const row = await get(kind, id, filter, conn, true);
            if (!row)
                throw new ForgeError("MSG-7201");
            await options.authorize(conn, row);
            revision(row, expected);
            if (kind === "template") {
                const used = await one("SELECT 1 FROM message_rules r JOIN message_template_versions v ON v.id=r.template_version_id WHERE v.template_id=? AND r.status<>'deleted' UNION SELECT 1 FROM message_deliveries m JOIN message_template_versions v ON v.id=m.template_version_id WHERE v.template_id=? UNION SELECT 1 FROM resource_references r JOIN message_template_versions v ON v.id=r.to_id WHERE r.to_type='message_template_version' AND v.template_id=? LIMIT 1", [id, id, id], conn);
                if (used)
                    throw new ForgeError("MSG-7206", { message: "模板仍被规则或发送记录引用" });
            }
            await conn.execute(`UPDATE ${tables[kind]} SET status='deleted',revision=revision+1 WHERE id=?`, [id]);
            await audit(conn, kind, options, row, "delete");
        }, "READ COMMITTED");
    },
};
