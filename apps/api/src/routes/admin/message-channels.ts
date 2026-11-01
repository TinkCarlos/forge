import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ForgeError, hasPermission, revisionTag, requireRevision, type Principal } from "@forge/core";
import { MESSAGE_CHANNEL_CREATE_SCHEMA, MESSAGE_CHANNEL_PATCH_SCHEMA, MESSAGE_PAGE_QUERY_SCHEMA, MESSAGE_VERSION_PAGE_SCHEMA, type MessageChannelDetail, type MessageChannelPatch } from "@forge/contracts";
import { messageConfigRepo, type MessageChannelRow, type MessageWrite } from "@forge/store";
import { resourceFilterFor, currentResourcePrincipal, assertPermission, assertConfigCreate, assertSecretReferences } from "@forge/governance";
import { admin, param } from "../../plugins/http-helpers.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../../plugins/input-schema.js";
function parse<T>(schema: z.ZodType<T>, body: unknown): T { const result = schema.safeParse(body); if (!result.success)
    throw new ForgeError("CFG-8501", { details: { fields: result.error.issues.map(issue => ({ path: issue.path.map(String).join("."), issue: issue.message })) } }); return result.data; }
function tag(reply: FastifyReply, revision: number) { reply.header("Cache-Control", "no-store").header("ETag", revisionTag(revision)); }
async function load(id: string, principal: Principal, action = "view") { const row = await messageConfigRepo.getMessageChannel(id, await resourceFilterFor(principal, "message_channel", action)); if (!row)
    throw new ForgeError("MSG-7201"); return row; }
async function present(rows: MessageChannelRow[], principal: Principal, action = "view"): Promise<MessageChannelDetail[]> {
    const editable = hasPermission(principal, "message.manage") ? new Set(await messageConfigRepo.manageableChannelIds(rows.map(row => row.id), await resourceFilterFor(principal, "message_channel", "manage"))) : new Set<string>();
    const testable = hasPermission(principal, "message.test") ? new Set(await messageConfigRepo.manageableChannelIds(rows.map(row => row.id), await resourceFilterFor(principal, "message_channel", "test"))) : new Set<string>();
    const result: MessageChannelDetail[] = [];
    const versions = new Map((await messageConfigRepo.channelSummaries(rows.map(row => row.id), await resourceFilterFor(principal, "message_channel", action))).map(version => [version.channel_id, version]));
    for (const row of rows) {
        const version = versions.get(row.id);
        if (!version)
            continue;
        result.push({ id: row.id, key: row.key, name: row.name, description: row.description, type: row.type, orgUnitId: row.owner_org_unit_id, status: row.status, revision: row.revision, activeVersionId: version.id, endpointMasked: "••••••", endpointFingerprint: version.endpoint_fingerprint, credentialConfigured: !!version.endpoint_secret_id && (row.type === "wecom" || !!version.signing_secret_id), legacyAppId: row.legacy_app_id, ...(editable.has(row.id) ? { mentionedIds: version.mentioned_ids_json, mentionedMobiles: version.mentioned_mobiles_json } : {}), referenceCount: Number(version.reference_count), allowedActions: [...(editable.has(row.id) ? ["manage" as const] : []), ...(testable.has(row.id) ? ["test" as const] : [])], createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
    }
    return result;
}
function write(principal: Principal, input: MessageChannelPatch & {
    orgUnitId?: string | null;
}): MessageWrite {
    if (principal.type === "app")
        throw new ForgeError("POL-2001");
    return { actor: { type: principal.type, id: principal.id }, authorize: async (conn, row) => {
            const { principal: live } = await currentResourcePrincipal(principal, conn);
            assertPermission(live, "message.manage");
            if (row && !await messageConfigRepo.getMessageChannel(row.id, await resourceFilterFor(principal, "message_channel", "manage", conn), conn))
                throw new ForgeError("MSG-7201");
            if (!row)
                await assertConfigCreate(principal, "message.manage", "message_channel", input.orgUnitId ?? null, conn);
            const references = [...(input.endpoint && "secretId" in input.endpoint ? [input.endpoint.secretId] : []), ...(input.signingSecret && "secretId" in input.signingSecret ? [input.signingSecret.secretId] : []), ...Object.values(input.headerSecretRefs ?? {})];
            await assertSecretReferences(live, references, conn);
        } };
}
export default async function messageChannelRoutes(app: FastifyInstance): Promise<void> {
    app.get("/admin/api/message-channels", { schema: ROUTE_SCHEMAS.messagePage, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.view"); assertValidInput(request, "querystring"); const input = parse(MESSAGE_PAGE_QUERY_SCHEMA, request.query), page = await messageConfigRepo.listMessageChannels(await resourceFilterFor(principal, "message_channel", "view"), { ...input, limit: input.limit ? Number(input.limit) : 50 }); reply.header("Cache-Control", "no-store"); return { ...page, items: await present(page.items, principal) }; });
    app.get("/admin/api/message-channels/:id", async (request, reply) => { const { principal } = await admin(request, "message.view"), row = await load(param(request, "id"), principal); tag(reply, row.revision); return (await present([row], principal))[0]; });
    app.post("/admin/api/message-channels", { schema: ROUTE_SCHEMAS.messageChannelCreate, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.manage"); assertValidInput(request); const input = parse(MESSAGE_CHANNEL_CREATE_SCHEMA, request.body); input.orgUnitId = input.orgUnitId === undefined ? principal.orgUnitId : input.orgUnitId; const row = await messageConfigRepo.createMessageChannel(input, await resourceFilterFor(principal, "message_channel", "manage"), write(principal, input)); tag(reply, row.revision); return reply.code(201).send((await present([row], principal, "manage"))[0]); });
    app.patch("/admin/api/message-channels/:id", { schema: ROUTE_SCHEMAS.messageChannelPatch, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.manage"), id = param(request, "id"); await load(id, principal, "manage"); assertValidInput(request); const input = parse(MESSAGE_CHANNEL_PATCH_SCHEMA, request.body), row = await messageConfigRepo.updateMessageChannel(id, input, requireRevision(request.headers["if-match"]), await resourceFilterFor(principal, "message_channel", "manage"), write(principal, input)); tag(reply, row.revision); return (await present([row], principal, "manage"))[0]; });
    app.delete("/admin/api/message-channels/:id", { schema: ROUTE_SCHEMAS.noBody, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.manage"), id = param(request, "id"); await load(id, principal, "manage"); assertValidInput(request); await messageConfigRepo.deleteMessageChannel(id, requireRevision(request.headers["if-match"]), await resourceFilterFor(principal, "message_channel", "manage"), write(principal, {})); return reply.code(204).send(); });
    app.get("/admin/api/message-channels/:id/versions", { schema: ROUTE_SCHEMAS.messageVersions, attachValidation: true }, async (request, reply) => { const { principal } = await admin(request, "message.view"), id = param(request, "id"); await load(id, principal); assertValidInput(request, "querystring"); const input = parse(MESSAGE_VERSION_PAGE_SCHEMA, request.query), page = await messageConfigRepo.listChannelVersions(id, await resourceFilterFor(principal, "message_channel", "view"), { limit: input.limit ? Number(input.limit) : 50, cursor: input.cursor }); reply.header("Cache-Control", "no-store"); return { ...page, items: page.items.map(row => ({ id: row.id, channelId: row.channel_id, version: row.version, endpointFingerprint: row.endpoint_fingerprint, createdAt: row.created_at.toISOString() })) }; });
}
