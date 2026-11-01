import { identityRepo } from "./identity.js";
import type { PoolConnection } from "mysql2/promise";
import { config, newId, sha256, type QueryFilter } from "@forge/core";
import type { MessageTemplate } from "@forge/contracts";
import { one, query, transaction } from "../db.js";
import { jobFilterSql } from "../job-filter.js";
import type { RunRow } from "../types.js";
export interface MessageEvent {
    id: string;
    type: string;
    sourceType: "run" | "job";
    sourceId: string;
    sourceGeneration: number;
    sourceSeq: string;
    ownerOrgUnitId: string | null;
    subjectType: "user" | "service" | "app";
    subjectId: string;
    appId: string | null;
    jobId?: string;
    agentId?: string;
    nested: boolean;
    createdAt: string;
    data: Record<string, unknown>;
    values: Partial<Record<MessageTemplate["variables"][number], string>>;
}
export interface FrozenMessageTarget {
    channelId: string;
    channelVersionId: string;
    type: "webhook" | "wecom";
    selectedRuleId: string;
    ruleIds: string[];
    templateVersionId: string | null;
    template: {
        key: string;
        name: string;
        content: string;
        variables: MessageTemplate["variables"];
    } | null;
    mentionedIds: string[];
    mentionedMobiles: string[];
}
export interface MessageOutbox {
    id: string;
    event_id: string;
    payload_json: MessageEvent;
    targets_json: FrozenMessageTarget[];
}
interface Match {
    rule_id: string;
    channel_id: string;
    channel_version_id: string;
    type: "webhook" | "wecom";
    template_version_id: string | null;
    template_key: string | null;
    template_name: string | null;
    template_content: string | null;
    variables_json: MessageTemplate["variables"] | null;
    mentioned_ids_json: string[];
    mentioned_mobiles_json: string[];
    scope_type: string;
    revision: number;
}
export async function freezeMessageEvent(conn: PoolConnection, event: MessageEvent): Promise<void> {
    const matches = await query<Match>(`SELECT r.id rule_id,r.revision,r.scope_type,c.id channel_id,v.id channel_version_id,c.type,r.template_version_id,t.\`key\` template_key,t.name template_name,tv.content template_content,tv.variables_json,v.mentioned_ids_json,v.mentioned_mobiles_json
 FROM message_rules r JOIN message_channels c ON c.id=r.channel_id AND c.status='active' JOIN message_channel_versions v ON v.id=c.published_version_id AND v.channel_id=c.id LEFT JOIN message_template_versions tv ON tv.id=r.template_version_id LEFT JOIN message_templates t ON t.id=tv.template_id
 WHERE r.status='active' AND r.event_type=? AND (r.owner_org_unit_id IS NULL OR r.owner_org_unit_id<=>?) AND (c.owner_org_unit_id IS NULL OR c.owner_org_unit_id<=>?)
 AND (r.template_version_id IS NULL OR (t.status='active' AND (t.owner_org_unit_id IS NULL OR t.owner_org_unit_id<=>?))) AND (?=0 OR r.include_nested_runs=1)
 AND (r.scope_type='global' OR (r.scope_type='org' AND r.scope_id=?) OR (r.scope_type='job' AND r.scope_id=?) OR (r.scope_type='agent' AND r.scope_id=?) OR (r.scope_type='api_app' AND r.scope_id=?))
 ORDER BY CASE r.scope_type WHEN 'job' THEN 0 WHEN 'agent' THEN 1 WHEN 'api_app' THEN 2 WHEN 'org' THEN 3 ELSE 4 END,r.id`, [event.type, event.ownerOrgUnitId, event.ownerOrgUnitId, event.ownerOrgUnitId, event.nested ? 1 : 0, event.ownerOrgUnitId, event.jobId ?? null, event.agentId ?? null, event.appId], conn);
    const targets = new Map<string, FrozenMessageTarget>();
    for (const row of matches) {
        const existing = targets.get(row.channel_id);
        if (existing) {
            existing.ruleIds.push(`${row.rule_id}:${row.revision}`);
            continue;
        }
        targets.set(row.channel_id, { channelId: row.channel_id, channelVersionId: row.channel_version_id, type: row.type, selectedRuleId: row.rule_id, ruleIds: [`${row.rule_id}:${row.revision}`], templateVersionId: row.template_version_id, template: row.template_version_id ? { key: row.template_key!, name: row.template_name!, content: row.template_content!, variables: row.variables_json! } : null, mentionedIds: row.mentioned_ids_json, mentionedMobiles: row.mentioned_mobiles_json });
    }
    if (!targets.size)
        return;
    const id = newId(), [inserted] = await conn.execute<import("mysql2").ResultSetHeader>("INSERT IGNORE INTO outbox_events(id,topic,event_id,source_type,source_id,source_seq,owner_org_unit_id,policy_json,targets_json,payload_json,available_at) VALUES(?,'message.fanout',?,?,?,?,?,'{}',?,?,UTC_TIMESTAMP(3))", [id, event.id, event.sourceType, event.sourceId, event.sourceSeq, event.ownerOrgUnitId, JSON.stringify([...targets.values()]), JSON.stringify(event)]);
    if (!inserted.affectedRows)
        return;
    for (const target of targets.values()) {
        await conn.execute("INSERT INTO resource_references(id,from_type,from_id,to_type,to_id,to_key,to_version,binding_key) VALUES(?,'outbox',?,'message_channel',?,?,?,?)", [newId(), id, target.channelId, target.channelId, target.channelVersionId, `channel:${target.channelId}`]);
        if (target.templateVersionId)
            await conn.execute("INSERT INTO resource_references(id,from_type,from_id,to_type,to_id,to_key,to_version,binding_key) VALUES(?,'outbox',?,'message_template_version',?,?,?,?)", [newId(), id, target.templateVersionId, target.templateVersionId, target.templateVersionId, `template:${target.channelId}`]);
    }
}
export async function freezeRunNotification(conn: PoolConnection, run: RunRow, eventType: string, approvalId?: string): Promise<void> {
    const agent = await one<{
        name: string;
    }>("SELECT name FROM agents WHERE id=?", [run.agent_id], conn);
    const createdAt = new Date().toISOString();
    await freezeMessageEvent(conn, { id: approvalId ? `approval_${approvalId}` : `evt_${run.id}`, type: eventType, sourceType: "run", sourceId: run.id, sourceGeneration: 1, sourceSeq: "1", ownerOrgUnitId: run.org_unit_id, subjectType: run.subject_type as MessageEvent["subjectType"], subjectId: run.subject_id, appId: run.app_id, agentId: run.agent_id, nested: false, createdAt, data: { runId: run.id, status: run.status, ...(approvalId ? { approvalId } : {}) }, values: { taskName: agent?.name ?? "Agent", status: run.status, runId: run.id, ...(approvalId ? { approvalId } : {}), url: new URL(`/#runs/${encodeURIComponent(run.id)}`, config.FORGE_PUBLIC_URL).href } });
}
export const messageFanoutRepo = {
    async due() { return query<{
        id: string;
    }>("SELECT id FROM outbox_events WHERE topic='message.fanout' AND status='pending' AND available_at<=UTC_TIMESTAMP(3) ORDER BY available_at,id LIMIT 20"); },
    async process(id: string, render: (event: MessageEvent, target: FrozenMessageTarget) => {
        body: string;
        errorCode: string | null;
    }) {
        return transaction(async (conn) => {
            const outbox = await one<MessageOutbox>("SELECT * FROM outbox_events WHERE id=? AND topic='message.fanout' AND status='pending' FOR UPDATE", [id], conn);
            if (!outbox)
                return;
            const event = outbox.payload_json;
            for (const target of outbox.targets_json) {
                const rendered = render(event, target), deliveryId = newId();
                await conn.execute("INSERT IGNORE INTO message_deliveries(id,event_id,event_type,source_type,source_id,source_generation,owner_org_unit_id,subject_type,subject_id,app_id,channel_id,channel_version_id,matched_rules_json,template_version_id,payload_body,payload_hash,status,last_error_code,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,IF(?='queued',UTC_TIMESTAMP(3),NULL))", [deliveryId, event.id, event.type, event.sourceType, event.sourceId, event.sourceGeneration, event.ownerOrgUnitId, event.subjectType, event.subjectId, event.appId, target.channelId, target.channelVersionId, JSON.stringify({ selectedRuleId: target.selectedRuleId ?? target.ruleIds[0]?.split(":")[0], ruleIds: target.ruleIds }), target.templateVersionId, Buffer.from(rendered.body), sha256(rendered.body), rendered.errorCode ? "failed" : "queued", rendered.errorCode, rendered.errorCode ? "failed" : "queued"]);
            }
            await conn.execute("UPDATE outbox_events SET status='processed',processed_at=UTC_TIMESTAMP(3),attempts=attempts+1 WHERE id=?", [id]);
            await conn.execute("DELETE FROM resource_references WHERE from_type='outbox' AND from_id=?", [id]);
        }, "READ COMMITTED");
    },
    async appRunSource(id: string, appId: string, conn: PoolConnection) {
        const row = await one<RunRow & {
            app_org: string | null;
            agent_org: string | null;
        }>(`SELECT r.*,a.owner_org_unit_id app_org,d.owner_org_unit_id agent_org FROM runs r JOIN api_apps a ON a.id=r.app_id JOIN agents d ON d.id=r.agent_id JOIN agent_versions v ON v.id=d.published_version_id AND v.agent_id=d.id WHERE r.id=? AND r.app_id=? AND r.subject_type='app' AND r.subject_id=a.id AND a.status='active' AND JSON_CONTAINS(a.scopes_json,JSON_QUOTE('runs:create')) AND d.status='active' AND d.deleted_at IS NULL AND d.api_enabled=1 AND v.status='published'`, [id, appId], conn);
        if (!row)
            return null;
        if (row.app_org && !await identityRepo.getActiveOrgUnit(row.app_org, conn))
            return null;
        if (row.agent_org && (!await identityRepo.getActiveOrgUnit(row.agent_org, conn) || !(await identityRepo.orgSubtreeIds(row.app_org, conn)).includes(row.agent_org)))
            return null;
        return row;
    },
    async runSource(id: string, filter: QueryFilter, conn?: PoolConnection) { const access = jobFilterSql(filter, "execution"); return one<RunRow>(`SELECT e.* FROM (SELECT runs.*,org_unit_id owner_org_unit_id FROM runs) e WHERE e.id=? AND ${access.sql}`, [id, ...access.params], conn); },
};
