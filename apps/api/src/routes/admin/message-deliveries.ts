import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ForgeError, hasPermission, revisionTag, requireRevision, type Principal } from "@forge/core";
import { MESSAGE_TEST_SCHEMA, MESSAGE_RETRY_SCHEMA, MESSAGE_CANCEL_SCHEMA, MESSAGE_DELIVERY_QUERY_SCHEMA, MESSAGE_VERSION_PAGE_SCHEMA, JOB_IDEMPOTENCY_KEY_SCHEMA, type MessageSummary, type MessageDetail, type MessageRetry, type MessageAttempt } from "@forge/contracts";
import { jobsRepo, messageConfigRepo, messageDeliveryRepo, messageCatalogRepo, messageFanoutRepo, type MessageDeliveryRow, type DeliveryWrite, type MessageWrite } from "@forge/store";
import { resourceFilterFor, currentResourcePrincipal,maskProseSecrets, assertPermission } from "@forge/governance";
import { wecomTextBody, renderMessageTemplate } from "@forge/runtime";
import { admin, param } from "../../plugins/http-helpers.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../../plugins/input-schema.js";
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success)
    throw new ForgeError("CFG-8501", { details: { fields: result.error.issues.map(issue => ({ path: issue.path.map(String).join("."), issue: issue.message })) } }); return result.data; }
function tag(reply: FastifyReply, revision: number) { reply.header("Cache-Control", "no-store").header("ETag", revisionTag(revision)); }
function summary(row: MessageDeliveryRow): MessageSummary { return { id: row.id, eventId: row.event_id, eventType: row.event_type, sourceType: row.source_type, sourceId: row.source_id, channelId: row.channel_id, channelVersionId: row.channel_version_id, status: row.status, holdReason: row.hold_reason, stateRevision: row.state_revision, sendCycle: row.send_cycle, totalAttempts: row.total_attempts, nextAttemptAt: row.next_attempt_at?.toISOString() ?? null, firstDeliveredAt: row.first_delivered_at?.toISOString() ?? null, lastDeliveredAt: row.last_delivered_at?.toISOString() ?? null, lastErrorCode: row.last_error_code, createdAt: row.created_at.toISOString() }; }
async function load(id: string, principal: Principal, action = "view") { const row = await messageDeliveryRepo.getDelivery(id, await resourceFilterFor(principal, "message_delivery", action)); if (!row)
    throw new ForgeError("MSG-7201"); return row; }
async function detail(row: MessageDeliveryRow, principal: Principal): Promise<MessageDetail> {
    let allowed = false;
    if (row.source_type === "test")
        allowed = !!await messageConfigRepo.getMessageChannel(row.channel_id, await resourceFilterFor(principal, "message_channel", "view"));
    else if (row.source_type === "job" && hasPermission(principal, "job.view"))
        allowed = !!await jobsRepo.getJobExecution(row.source_id, await resourceFilterFor(principal, "job_execution", "view"));
    else if (row.source_type === "run" && hasPermission(principal, "run.view")) {
        allowed = !!await messageFanoutRepo.runSource(row.source_id, await resourceFilterFor(principal, "run", "view"));
    }
    let payload: unknown = null;
    if (allowed && row.payload_body) {
        try {
            payload = JSON.parse(row.payload_body.toString("utf8"));
        }
        catch {
            payload = null;
        }
    }
    const retryable = hasPermission(principal, "message.retry") && !!await messageDeliveryRepo.getDelivery(row.id, await resourceFilterFor(principal, "message_delivery", "retry"));
    return { ...summary(row), matchedRules: row.matched_rules_json, templateVersionId: row.template_version_id, payloadHash: row.payload_hash, attemptsUrl: `/admin/api/message-deliveries/${row.id}/attempts`, payload, bodyRedacted: !allowed, duplicateRisk: await messageDeliveryRepo.duplicateRisk(row.id, await resourceFilterFor(principal, "message_delivery", "view")), allowedActions: retryable ? [...(["failed", "unknown", "held", "cancelled", "delivered"].includes(row.status) ? ["retry" as const] : []), ...(["queued", "retry_wait", "sending", "unknown", "held"].includes(row.status) ? ["cancel" as const] : [])] : [] };
}
function options(principal: Principal, action: "retry" | "cancel", input: MessageRetry): DeliveryWrite {
    if (principal.type === "app")
        throw new ForgeError("POL-2001");
    return { auditReason:maskProseSecrets(input.reason),actor: { type: principal.type, id: principal.id }, authorize: async (conn, row, channel) => {
            const { principal: live } = await currentResourcePrincipal(principal, conn);
            assertPermission(live, "message.retry");
            if (!await messageDeliveryRepo.getDelivery(row.id, await resourceFilterFor(principal, "message_delivery", "retry", conn), conn))
                throw new ForgeError("MSG-7201");
            if (action === "retry" && channel.published_version_id !== row.channel_version_id) {
                if (!input.acknowledgeHistoricalTarget)
                    throw new ForgeError("MSG-7202");
                assertPermission(live, "message.manage");
                if (!await messageConfigRepo.getMessageChannel(channel.id, await resourceFilterFor(principal, "message_channel", "manage", conn), conn))
                    throw new ForgeError("MSG-7201");
            }
        } };
}
export default async function messageDeliveryRoutes(app: FastifyInstance): Promise<void> {
    const actions: ("retry" | "cancel")[] = ["retry", "cancel"];
    app.post("/admin/api/message-channels/:id/test", { schema: ROUTE_SCHEMAS.messageTest, attachValidation: true }, async (request, reply) => {
        const { principal } = await admin(request, "message.test");
        const id = param(request, "id"), filter = await resourceFilterFor(principal, "message_channel", "test"), channel = await messageConfigRepo.getMessageChannel(id, filter);
        if (!channel)
            throw new ForgeError("MSG-7201");
        assertValidInput(request);
        const input = parse(MESSAGE_TEST_SCHEMA, request.body), expectedRevision = requireRevision(request.headers["if-match"]), idempotencyKey = parse(JOB_IDEMPOTENCY_KEY_SCHEMA, request.headers["idempotency-key"]);
        if (principal.type === "app")
            throw new ForgeError("POL-2001");
        const write: MessageWrite = { actor: { type: principal.type, id: principal.id }, authorize: async (conn, row) => { const { principal: live } = await currentResourcePrincipal(principal, conn); assertPermission(live, "message.test"); if (!row || !await messageConfigRepo.getMessageChannel(row.id, await resourceFilterFor(principal, "message_channel", "test", conn), conn))
                throw new ForgeError("MSG-7201"); } };
        const accepted = await messageDeliveryRepo.enqueueTest({ channelId: id, expectedRevision, idempotencyKey, ...input }, filter, write, async (row, version, _conn, eventId) => {
            let text = "[TEST] Forge 渠道技术测试";
            if (input.templateVersionId) {
                if (row.type !== "wecom")
                    throw new ForgeError("MSG-7206");
                const templateFilter = await resourceFilterFor(principal, "message_template", "view", _conn), frozen = await messageCatalogRepo.getTemplateVersion(input.templateVersionId, templateFilter, _conn);
                if (!frozen)
                    throw new ForgeError("MSG-7201");
                const template = await messageCatalogRepo.getTemplate(frozen.template_id, templateFilter, _conn, true);
                if (!template || template.status !== "active" || (template.owner_org_unit_id !== null && template.owner_org_unit_id !== row.owner_org_unit_id))
                    throw new ForgeError("MSG-7201");
                text = renderMessageTemplate({ key: template.key, name: template.name, content: frozen.content, variables: frozen.variables_json }, { taskName: "[TEST] 渠道技术测试", businessSummary: "[TEST] 技术摘要", status: "test", executionId: "TEST", runId: "TEST", approvalId: "TEST", responsibleName: "TEST", url: "https://example.invalid/test" });
                if (!text.includes("[TEST]"))
                    text = `[TEST] ${text}`;
            }
            return row.type === "wecom" ? wecomTextBody(text, { mentionedIds: version.mentioned_ids_json, mentionedMobiles: version.mentioned_mobiles_json }) : JSON.stringify({ id: eventId, type: "test.webhook", version: "1", createdAt: new Date().toISOString(), data: { test: true, summary: text } });
        });
        reply.header("Cache-Control", "no-store");
        return reply.code(202).send(accepted);
    });
    app.get("/admin/api/message-deliveries", { schema: ROUTE_SCHEMAS.messageDeliveries, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.view"); assertValidInput(request, "querystring"); const input = parse(MESSAGE_DELIVERY_QUERY_SCHEMA, request.query), page = await messageDeliveryRepo.listDeliveries(await resourceFilterFor(principal, "message_delivery", "view"), { ...input, limit: input.limit ? Number(input.limit) : 50 }); reply.header("Cache-Control", "no-store"); return { ...page, items: page.items.map(summary) }; });
    app.get("/admin/api/message-deliveries/:id", async (request, reply) => { const { principal } = await admin(request, "message.view"), row = await load(param(request, "id"), principal); tag(reply, row.state_revision); return detail(row, principal); });
    app.get("/admin/api/message-deliveries/:id/attempts", { schema: ROUTE_SCHEMAS.messageVersions, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.view"), id = param(request, "id"); await load(id, principal); assertValidInput(request, "querystring"); const input = parse(MESSAGE_VERSION_PAGE_SCHEMA, request.query), page = await messageDeliveryRepo.listAttempts(id, await resourceFilterFor(principal, "message_delivery", "view"), { limit: input.limit ? Number(input.limit) : 50, cursor: input.cursor }); reply.header("Cache-Control", "no-store"); return { ...page, items: page.items.map((row): MessageAttempt => ({ id: row.id, attemptNo: row.attempt_no, sendCycle: row.send_cycle, status: row.status, channelVersionId: row.channel_version_id, endpointFingerprint: row.endpoint_fingerprint, payloadHash: row.payload_hash, submittedAt: row.submitted_at?.toISOString() ?? null, completedAt: row.completed_at?.toISOString() ?? null, responseStatus: row.response_status, responseSummary: row.response_summary, errorCode: row.error_code, uncertain: !!row.uncertain, createdAt: row.created_at.toISOString() })) }; });
    {
        const action = actions[0]!;
        app.post("/admin/api/message-deliveries/:id/retry", { schema: ROUTE_SCHEMAS.messageRetry, attachValidation: true }, async (request, reply) => {
            const { principal } = await admin(request, "message.retry"), id = param(request, "id");
            await load(id, principal, "retry");
            assertValidInput(request);
            const input = action === "retry" ? parse(MESSAGE_RETRY_SCHEMA, request.body) : parse(MESSAGE_CANCEL_SCHEMA, request.body), expected = requireRevision(request.headers["if-match"]), key = parse(JOB_IDEMPOTENCY_KEY_SCHEMA, request.headers["idempotency-key"]);
            const result = await messageDeliveryRepo.control(id, action, input, expected, key, await resourceFilterFor(principal, "message_delivery", "retry"), options(principal, action, input));
            reply.header("Cache-Control", "no-store");
            return reply.code(202).send(result);
        });
    }
    {
        const action = actions[1]!;
        app.post("/admin/api/message-deliveries/:id/cancel", { schema: ROUTE_SCHEMAS.messageCancel, attachValidation: true }, async (request, reply) => {
            const { principal } = await admin(request, "message.retry"), id = param(request, "id");
            await load(id, principal, "retry");
            assertValidInput(request);
            const input = action === "retry" ? parse(MESSAGE_RETRY_SCHEMA, request.body) : parse(MESSAGE_CANCEL_SCHEMA, request.body), expected = requireRevision(request.headers["if-match"]), key = parse(JOB_IDEMPOTENCY_KEY_SCHEMA, request.headers["idempotency-key"]);
            const result = await messageDeliveryRepo.control(id, action, input, expected, key, await resourceFilterFor(principal, "message_delivery", "retry"), options(principal, action, input));
            reply.header("Cache-Control", "no-store");
            return reply.code(202).send(result);
        });
    }
}
