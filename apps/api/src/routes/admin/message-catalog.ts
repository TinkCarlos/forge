import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ForgeError, hasPermission, revisionTag, requireRevision, type Principal } from "@forge/core";
import { MESSAGE_RULE_CREATE_SCHEMA, MESSAGE_RULE_PATCH_SCHEMA, MESSAGE_TEMPLATE_CREATE_SCHEMA, MESSAGE_TEMPLATE_PATCH_SCHEMA, MESSAGE_PAGE_QUERY_SCHEMA, MESSAGE_VERSION_PAGE_SCHEMA, type MessageTemplateDetail, type MessageRuleDetail, type MessageTemplateVersion } from "@forge/contracts";
import { messageCatalogRepo, messageConfigRepo, messageRuleSourceOwner, repos, type MessageTemplateRow, type MessageRuleRow, type MessageCatalogKind, type CatalogWrite } from "@forge/store";
import { resourceFilterFor, currentResourcePrincipal, assertPermission, assertConfigCreate, assertOrgWritable } from "@forge/governance";
import { admin, param } from "../../plugins/http-helpers.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../../plugins/input-schema.js";
function parse<T>(schema: z.ZodType<T>, body: unknown): T { const result = schema.safeParse(body); if (!result.success)
    throw new ForgeError("CFG-8501", { details: { fields: result.error.issues.map(issue => ({ path: issue.path.map(String).join("."), issue: issue.message })) } }); return result.data; }
function tag(reply: FastifyReply, revision: number) { reply.header("Cache-Control", "no-store").header("ETag", revisionTag(revision)); }
async function load(kind: MessageCatalogKind, id: string, principal: Principal, action = "view") { const filter = await resourceFilterFor(principal, `message_${kind}`, action), row = kind === "template" ? await messageCatalogRepo.getTemplate(id, filter) : await messageCatalogRepo.getRule(id, filter); if (!row)
    throw new ForgeError("MSG-7201"); return row; }
async function presentTemplates(rows: MessageTemplateRow[], principal: Principal): Promise<MessageTemplateDetail[]> {
    const ids = hasPermission(principal, "message.manage") ? new Set(await messageCatalogRepo.manageableIds("template", rows.map(row => row.id), await resourceFilterFor(principal, "message_template", "manage"))) : new Set();
    return rows.map(row => ({ id: row.id, key: row.key, name: row.name, description: row.description, orgUnitId: row.owner_org_unit_id, status: row.status, revision: row.revision, activeVersionId: row.published_version_id, ...(ids.has(row.id) ? { draft: row.draft_json } : {}), allowedActions: ids.has(row.id) ? ["manage"] : [], createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }));
}
async function presentRules(rows: MessageRuleRow[], principal: Principal): Promise<MessageRuleDetail[]> {
    const ids = hasPermission(principal, "message.manage") ? new Set(await messageCatalogRepo.manageableIds("rule", rows.map(row => row.id), await resourceFilterFor(principal, "message_rule", "manage"))) : new Set();
    const parents = new Map((await messageCatalogRepo.ruleTemplateParents(rows.flatMap(row => row.template_version_id ? [row.template_version_id] : []))).map(item => [item.id, item.template_id]));
    return rows.map(row => ({ id: row.id, key: row.key, name: row.name, eventType: row.event_type, scope: row.scope_type === "global" ? { type: "global" } : { type: row.scope_type, id: row.scope_id! }, channelId: row.channel_id, templateVersionId: row.template_version_id, templateId: row.template_version_id ? parents.get(row.template_version_id) ?? null : null, includeNestedRuns: !!row.include_nested_runs, status: row.status, revision: row.revision, orgUnitId: row.owner_org_unit_id, allowedActions: ids.has(row.id) ? ["manage"] : [], createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }));
}
function write(principal: Principal, kind: MessageCatalogKind, org?: string | null): CatalogWrite {
    if (principal.type === "app")
        throw new ForgeError("POL-2001");
    return { actor: { type: principal.type, id: principal.id }, authorize: async (conn, row) => {
            const { principal: live } = await currentResourcePrincipal(principal, conn);
            assertPermission(live, "message.manage");
            if (row) {
                const filter = await resourceFilterFor(principal, `message_${kind}`, "manage", conn);
                if (!(kind === "template" ? await messageCatalogRepo.getTemplate(row.id, filter, conn) : await messageCatalogRepo.getRule(row.id, filter, conn)))
                    throw new ForgeError("MSG-7201");
            }
            else if (kind === "template")
                await assertConfigCreate(principal, "message.manage", "message_template", org ?? null, conn);
        } };
}
function ruleValidator(principal: Principal) {
    return async (row: MessageRuleRow, conn: Parameters<CatalogWrite["authorize"]>[0]) => {
        const { principal: live, roles } = await currentResourcePrincipal(principal, conn);
        let org: string | null;
        if (row.scope_type === "global") {
            if (!roles.includes("platform_admin"))
                throw new ForgeError("POL-2001");
            org = null;
        }
        else if (row.scope_type === "org") {
            assertPermission(live, "org.view");
            if (!await repos.getActiveOrgUnit(row.scope_id!, conn))
                throw new ForgeError("MSG-7201");
            await assertOrgWritable(live, row.scope_id!, undefined, conn);
            org = row.scope_id;
        }
        else {
            const resource = { job: "job_definition", agent: "agent", api_app: "api_app" }[row.scope_type], permission = { job: "job.view", agent: "agent.view", api_app: "apikey.view" }[row.scope_type];
            assertPermission(live, permission);
            const source = await messageRuleSourceOwner(row.scope_type, row.scope_id!, await resourceFilterFor(principal, resource, "view", conn), conn);
            if (!source)
                throw new ForgeError("MSG-7201");
            org = source.owner_org_unit_id;
        }
        await assertConfigCreate(principal, "message.manage", "message_rule", org, conn);
        const channel = await messageConfigRepo.getMessageChannel(row.channel_id, await resourceFilterFor(principal, "message_channel", "manage", conn), conn, true);
        if (!channel)
            throw new ForgeError("MSG-7201");
        if (channel.owner_org_unit_id !== null && channel.owner_org_unit_id !== org)
            throw new ForgeError("POL-2001");
        if (row.status === "active" && channel.status !== "active")
            throw new ForgeError("MSG-7202");
        if (channel.type === "webhook" && row.template_version_id)
            throw new ForgeError("MSG-7206", { message: "Webhook保留结构化事件，不能使用文本模板" });
        if (row.template_version_id) {
            const version = await messageCatalogRepo.getTemplateVersion(row.template_version_id, await resourceFilterFor(principal, "message_template", "view", conn), conn);
            if (!version)
                throw new ForgeError("MSG-7201");
            const template = await messageCatalogRepo.getTemplate(version.template_id, await resourceFilterFor(principal, "message_template", "view", conn), conn, true);
            if (!template || (template.owner_org_unit_id !== null && template.owner_org_unit_id !== org))
                throw new ForgeError("MSG-7201");
            if (row.status === "active" && template.status !== "active")
                throw new ForgeError("MSG-7206", { message: "请先启用模板" });
        }
        return org;
    };
}
export default async function messageCatalogRoutes(app: FastifyInstance): Promise<void> {
    const kinds: MessageCatalogKind[] = ["template", "rule"];
    {
        const kind = kinds[0]!;
        app.get("/admin/api/message-templates", { schema: ROUTE_SCHEMAS.messagePage, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.view"); assertValidInput(request, "querystring"); const input = parse(MESSAGE_PAGE_QUERY_SCHEMA, request.query), filter = await resourceFilterFor(principal, `message_${kind}`, "view"), page = await messageCatalogRepo.list(kind, filter, { ...input, limit: input.limit ? Number(input.limit) : 50 }); reply.header("Cache-Control", "no-store"); return { ...page, items: kind === "template" ? await presentTemplates(page.items as MessageTemplateRow[], principal) : await presentRules(page.items as MessageRuleRow[], principal) }; });
        app.get("/admin/api/message-templates/:id", async (request, reply) => { const { principal } = await admin(request, "message.view"), row = await load(kind, param(request, "id"), principal); tag(reply, row.revision); return kind === "template" ? (await presentTemplates([row as MessageTemplateRow], principal))[0] : (await presentRules([row as MessageRuleRow], principal))[0]; });
        app.post("/admin/api/message-templates", { schema: ROUTE_SCHEMAS.messageTemplateCreate, attachValidation: true }, async (request, reply) => {
            const { principal } = await admin(request, "message.manage");
            assertValidInput(request);
            const filter = await resourceFilterFor(principal, `message_${kind}`, "manage");
            if (kind === "template") {
                const input = parse(MESSAGE_TEMPLATE_CREATE_SCHEMA, request.body);
                input.orgUnitId = input.orgUnitId === undefined ? principal.orgUnitId : input.orgUnitId;
                const row = await messageCatalogRepo.createTemplate(input, filter, write(principal, kind, input.orgUnitId));
                tag(reply, row.revision);
                return reply.code(201).send((await presentTemplates([row], principal))[0]);
            }
            const input = parse(MESSAGE_RULE_CREATE_SCHEMA, request.body), row = await messageCatalogRepo.saveRule(null, input, null, filter, write(principal, kind), ruleValidator(principal));
            tag(reply, row.revision);
            return reply.code(201).send((await presentRules([row], principal))[0]);
        });
        app.patch("/admin/api/message-templates/:id", { schema: ROUTE_SCHEMAS.messageTemplatePatch, attachValidation: true }, async (request, reply) => {
            const { principal } = await admin(request, "message.manage"), id = param(request, "id");
            await load(kind, id, principal, "manage");
            assertValidInput(request);
            const expected = requireRevision(request.headers["if-match"]), filter = await resourceFilterFor(principal, `message_${kind}`, "manage");
            const row = kind === "template" ? await messageCatalogRepo.updateTemplate(id, parse(MESSAGE_TEMPLATE_PATCH_SCHEMA, request.body), expected, filter, write(principal, kind)) : await messageCatalogRepo.saveRule(id, parse(MESSAGE_RULE_PATCH_SCHEMA, request.body), expected, filter, write(principal, kind), ruleValidator(principal));
            tag(reply, row.revision);
            return kind === "template" ? (await presentTemplates([row as MessageTemplateRow], principal))[0] : (await presentRules([row as MessageRuleRow], principal))[0];
        });
        app.delete("/admin/api/message-templates/:id", { schema: ROUTE_SCHEMAS.noBody, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.manage"), id = param(request, "id"); await load(kind, id, principal, "manage"); assertValidInput(request); await messageCatalogRepo.remove(kind, id, requireRevision(request.headers["if-match"]), await resourceFilterFor(principal, `message_${kind}`, "manage"), write(principal, kind)); return reply.code(204).send(); });
    }
    {
        const kind = kinds[1]!;
        app.get("/admin/api/message-rules", { schema: ROUTE_SCHEMAS.messagePage, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.view"); assertValidInput(request, "querystring"); const input = parse(MESSAGE_PAGE_QUERY_SCHEMA, request.query), filter = await resourceFilterFor(principal, `message_${kind}`, "view"), page = await messageCatalogRepo.list(kind, filter, { ...input, limit: input.limit ? Number(input.limit) : 50 }); reply.header("Cache-Control", "no-store"); return { ...page, items: kind === "template" ? await presentTemplates(page.items as MessageTemplateRow[], principal) : await presentRules(page.items as MessageRuleRow[], principal) }; });
        app.get("/admin/api/message-rules/:id", async (request, reply) => { const { principal } = await admin(request, "message.view"), row = await load(kind, param(request, "id"), principal); tag(reply, row.revision); return kind === "template" ? (await presentTemplates([row as MessageTemplateRow], principal))[0] : (await presentRules([row as MessageRuleRow], principal))[0]; });
        app.post("/admin/api/message-rules", { schema: ROUTE_SCHEMAS.messageRuleCreate, attachValidation: true }, async (request, reply) => {
            const { principal } = await admin(request, "message.manage");
            assertValidInput(request);
            const filter = await resourceFilterFor(principal, `message_${kind}`, "manage");
            if (kind === "template") {
                const input = parse(MESSAGE_TEMPLATE_CREATE_SCHEMA, request.body);
                input.orgUnitId = input.orgUnitId === undefined ? principal.orgUnitId : input.orgUnitId;
                const row = await messageCatalogRepo.createTemplate(input, filter, write(principal, kind, input.orgUnitId));
                tag(reply, row.revision);
                return reply.code(201).send((await presentTemplates([row], principal))[0]);
            }
            const input = parse(MESSAGE_RULE_CREATE_SCHEMA, request.body), row = await messageCatalogRepo.saveRule(null, input, null, filter, write(principal, kind), ruleValidator(principal));
            tag(reply, row.revision);
            return reply.code(201).send((await presentRules([row], principal))[0]);
        });
        app.patch("/admin/api/message-rules/:id", { schema: ROUTE_SCHEMAS.messageRulePatch, attachValidation: true }, async (request, reply) => {
            const { principal } = await admin(request, "message.manage"), id = param(request, "id");
            await load(kind, id, principal, "manage");
            assertValidInput(request);
            const expected = requireRevision(request.headers["if-match"]), filter = await resourceFilterFor(principal, `message_${kind}`, "manage");
            const row = kind === "template" ? await messageCatalogRepo.updateTemplate(id, parse(MESSAGE_TEMPLATE_PATCH_SCHEMA, request.body), expected, filter, write(principal, kind)) : await messageCatalogRepo.saveRule(id, parse(MESSAGE_RULE_PATCH_SCHEMA, request.body), expected, filter, write(principal, kind), ruleValidator(principal));
            tag(reply, row.revision);
            return kind === "template" ? (await presentTemplates([row as MessageTemplateRow], principal))[0] : (await presentRules([row as MessageRuleRow], principal))[0];
        });
        app.delete("/admin/api/message-rules/:id", { schema: ROUTE_SCHEMAS.noBody, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.manage"), id = param(request, "id"); await load(kind, id, principal, "manage"); assertValidInput(request); await messageCatalogRepo.remove(kind, id, requireRevision(request.headers["if-match"]), await resourceFilterFor(principal, `message_${kind}`, "manage"), write(principal, kind)); return reply.code(204).send(); });
    }
    app.post("/admin/api/message-templates/:id/publish", { schema: ROUTE_SCHEMAS.jobEmpty, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.manage"), id = param(request, "id"); await load("template", id, principal, "manage"); assertValidInput(request); const result = await messageCatalogRepo.publishTemplate(id, requireRevision(request.headers["if-match"]), await resourceFilterFor(principal, "message_template", "manage"), write(principal, "template")); tag(reply, result.revision); return reply.code(201).send(result); });
    app.get("/admin/api/message-templates/:id/versions", { schema: ROUTE_SCHEMAS.messageVersions, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.view"), id = param(request, "id"); await load("template", id, principal); assertValidInput(request, "querystring"); const input = parse(MESSAGE_VERSION_PAGE_SCHEMA, request.query), page = await messageCatalogRepo.listTemplateVersions(id, await resourceFilterFor(principal, "message_template", "view"), { limit: input.limit ? Number(input.limit) : 50, cursor: input.cursor }); reply.header("Cache-Control", "no-store"); return { ...page, items: page.items.map((row): MessageTemplateVersion => ({ id: row.id, templateId: row.template_id, version: row.version, content: row.content, variables: row.variables_json, contentHash: row.content_hash, createdAt: row.created_at.toISOString() })) }; });
}
