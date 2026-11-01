import { randomBytes } from "node:crypto";
import { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiAppListResult, ApiKeyListResult, ApiKeyCreateResult, ApiKeyRevokeResult, ApiKeyRotationResult } from "@forge/contracts";
import { assertOutboundUrlStatic, config, errors, hashApiKey, hasPermission } from "@forge/core";
import { deliverDueWebhooks, idempotencyRequestHash } from "@forge/runtime";
import { assertOrgWritable, assertSecretReferences, dataScopeFor, scopeCoversOrg } from "@forge/governance";
import { repos } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  arrayBody,
  admin,
  writeAudit,
  configurationWrite,
  configurationResult,
  requireBodyString,
} from "../../plugins/http-helpers.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../../plugins/input-schema.js";

/** Webhook URL from the body, statically checked by the outbound guard (S-46); empty -> null. */
function webhookUrlOf(body: Record<string, unknown>): string | null {
  const url = stringBody(body, "webhookUrl");
  if (!url) return null;
  assertOutboundUrlStatic(url);
  return url;
}

export default async function adminAppRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/api/apps/:id/webhook-deliveries", async (request) => {
    await admin(request, "apikey.view");
    const app = await repos.getApiApp(param(request, "id"));
    if (!app) throw errors.notFound("应用不存在");
    const items = await repos.listWebhookDeliveries(String(app.id));
    return {
      items: items.map((item) => ({
        id: item.id,
        eventId: item.event_id,
        eventType: item.event_type,
        status: item.status,
        attempts: item.attempts,
        responseStatus: item.response_status,
        errorMessage: item.error_message,
        errorCode: item.error_code ?? null,
        nextAttemptAt: item.next_attempt_at,
        deliveredAt: item.delivered_at,
        createdAt: item.created_at,
      })),
    };
  });

  app.post("/admin/api/webhook-deliveries/:id/replay", { schema: ROUTE_SCHEMAS.noBody, attachValidation: true }, async (request) => {
    const session = await admin(request, "apikey.manage");
    const delivery = await repos.getWebhookDelivery(param(request, "id"));
    if (!delivery) throw errors.notFound("投递记录不存在");
    const owner = await repos.getApiApp(String(delivery.app_id));
    await assertOrgWritable(session.principal, owner ? (owner.owner_org_unit_id as string | null) : null);
    assertValidInput(request);
    const replayed = await repos.replayWebhookDelivery(String(delivery.id));
    if (!replayed) throw errors.conflict("投递记录无法重放");
    await writeAudit(session, "webhook.replay", "webhook_delivery", String(delivery.id), { eventId: delivery.event_id });
    await deliverDueWebhooks();
    const fresh = await repos.getWebhookDelivery(String(delivery.id));
    return { ok: true, status: fresh?.status ?? "pending" };
  });

  app.get("/admin/api/apps", async (request): Promise<ApiAppListResult> => {
    const session = await admin(request, "apikey.view");
    const canCreate = hasPermission(session.principal, "apikey.manage");
    const scope = await dataScopeFor(session.principal);
    const apps = await repos.listApiApps();
    return {
      canCreate,
      items: apps.map((app) => ({
        id: app.id,
        revision: app.revision,
        key: app.key,
        name: app.name,
        status: app.status,
        scopes: app.scopes_json,
        webhookUrl: app.webhook_url,
        webhookSecretId: app.webhook_secret_id ?? null,
        rateLimitPerMinute: app.rate_limit_per_minute,
        dailyQuota: app.daily_quota,
        createdAt: app.created_at.toISOString(),
        canManage: canCreate && scopeCoversOrg(scope, app.owner_org_unit_id as string | null),
      })),
    };
  });

  app.post("/admin/api/apps", { schema: ROUTE_SCHEMAS.appCreate, attachValidation: true }, async (request) => {
    const session = await admin(request, "apikey.manage");
    assertValidInput(request);
    const body = bodyOf(request);
    const key = requireBodyString(body, "key");
    const webhookSecret = stringBody(body, "webhookSecret");
    const webhookSecretId = body.webhookSecretId as string | null | undefined;
    await assertSecretReferences(session.principal, webhookSecretId ? [webhookSecretId] : []);
    const appId = await repos.createApiApp({
      key,
      name: stringBody(body, "name", key),
      description: stringBody(body, "description"),
      ownerOrgUnitId: session.principal.orgUnitId,
      scopes: arrayBody(body, "scopes").length ? arrayBody(body, "scopes") : ["agents:read", "runs:create", "runs:read", "runs:cancel"],
      webhookUrl: webhookUrlOf(body),
      webhookSecret: webhookSecret || undefined,
      webhookSecretId,
      rateLimitPerMinute: body.rateLimitPerMinute === undefined ? 60 : Number(body.rateLimitPerMinute), // schema: integer 1..100000
      dailyQuota: body.dailyQuota === undefined ? 1000 : Number(body.dailyQuota), // schema: integer 1..10000000
      createdBy: session.principal.id,
    }, { actorType: "user", actorId: session.principal.id, action: "app.create", resourceType: "api_app", resourceId: null, details: { key }, orgUnitId: session.principal.orgUnitId });
    return { id: appId };
  });

  app.patch("/admin/api/apps/:id", { schema: ROUTE_SCHEMAS.appPatch, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "apikey.manage");
    const app = await repos.getApiApp(param(request, "id"));
    if (!app) throw errors.notFound("应用不存在");
    await assertOrgWritable(session.principal, app.owner_org_unit_id as string | null);
    assertValidInput(request);
    const body = bodyOf(request);
    const fields: Record<string, unknown> = {};
    if (body.name !== undefined) fields.name = stringBody(body, "name");
    if (body.description !== undefined) fields.description = stringBody(body, "description");
    if (body.status !== undefined) fields.status = stringBody(body, "status");
    if (body.scopes !== undefined) fields.scopes_json = arrayBody(body, "scopes");
    if (body.webhookUrl !== undefined) fields.webhook_url = webhookUrlOf(body);
    if (body.webhookSecret) fields.webhook_secret = stringBody(body, "webhookSecret");
    if (body.webhookSecretId !== undefined) fields.webhook_secret_id = body.webhookSecretId;
    await assertSecretReferences(session.principal, typeof fields.webhook_secret_id === "string" ? [fields.webhook_secret_id] : []);
    if (body.rateLimitPerMinute !== undefined) fields.rate_limit_per_minute = Number(body.rateLimitPerMinute);
    if (body.dailyQuota !== undefined) fields.daily_quota = Number(body.dailyQuota);
    const revision = await repos.updateApiApp(String(app.id), fields, configurationWrite(request, session, "app.update", "api_app", String(app.id), { name: fields.name, status: fields.status }, app.owner_org_unit_id));
    return configurationResult(reply, revision);
  });

  app.post("/admin/api/apps/:id/keys", { schema: ROUTE_SCHEMAS.apiKeyCreate, attachValidation: true }, async (request, reply): Promise<ApiKeyCreateResult> => {
    const session = await admin(request, "apikey.manage");
    const app = await repos.getApiApp(param(request, "id"));
    if (!app) throw errors.notFound("应用不存在");
    await assertOrgWritable(session.principal, app.owner_org_unit_id as string | null);
    assertValidInput(request);
    const body = bodyOf(request);
    let expiresAt: Date | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      const parsed = z.iso.datetime({ offset: true }).safeParse(body.expiresAt);
      if (!parsed.success || new Date(parsed.data).getTime() <= Date.now()) throw errors.invalid("有效期必须为未来的 RFC3339 时间", { field: "expiresAt" });
      expiresAt = new Date(parsed.data);
    }
    const rawKey = `fsk_${randomBytes(32).toString("base64url")}`;
    const prefix = rawKey.slice(0, 16);
    const keyId = await repos.createApiKey({
      appId: String(app.id),
      name: stringBody(body, "name", "default"),
      prefix,
      keyHash: hashApiKey(rawKey, config.API_KEY_PEPPER),
      scopes: Array.isArray(app.scopes_json) ? (app.scopes_json as string[]) : [],
      expiresAt,
    }, { actorId: session.principal.id, orgUnitId: app.owner_org_unit_id as string | null });
    reply.header("Cache-Control", "no-store");
    return { id: keyId, key: rawKey, prefix, expiresAt: expiresAt?.toISOString() ?? null, warning: "此密钥只显示一次，请立即保存" };
  });

  app.post("/admin/api/api-keys/:id/revoke", { schema: ROUTE_SCHEMAS.noBody, attachValidation: true }, async (request): Promise<ApiKeyRevokeResult> => {
    const session = await admin(request, "apikey.manage");
    const id = param(request, "id");
    const owner = await repos.getApiKeyOwner(id);
    if (!owner) throw errors.notFound("密钥不存在");
    await assertOrgWritable(session.principal, owner.owner_org_unit_id);
    assertValidInput(request);
    await repos.revokeApiKey(id, { actorId: session.principal.id, orgUnitId: owner.owner_org_unit_id });
    return { ok: true, appId: owner.app_id };
  });

  app.post("/admin/api/api-keys/:id/rotate", { schema: ROUTE_SCHEMAS.apiKeyRotate, attachValidation: true }, async (request, reply): Promise<ApiKeyRotationResult> => {
    const session = await admin(request, "apikey.manage");
    const id = param(request, "id");
    const owner = await repos.getApiKeyOwner(id);
    if (!owner) throw errors.notFound("密钥不存在");
    await assertOrgWritable(session.principal, owner.owner_org_unit_id);
    assertValidInput(request);
    const body = bodyOf(request);
    const overlapSeconds = body.overlapSeconds === undefined ? 0 : Number(body.overlapSeconds);
    const header = request.headers["idempotency-key"];
    if (typeof header !== "string" || !header.trim() || header.length > 200) throw errors.invalid("请提供 1–200 字符的 Idempotency-Key", { field: "Idempotency-Key" });
    const rawKey = `fsk_${randomBytes(32).toString("base64url")}`;
    const { created, result } = await repos.rotateApiKey({ id, prefix: rawKey.slice(0, 16), keyHash: hashApiKey(rawKey, config.API_KEY_PEPPER), overlapSeconds, idempotencyKey: header.trim(), requestHash: idempotencyRequestHash({ overlapSeconds }) }, { actorId: session.principal.id, orgUnitId: owner.owner_org_unit_id });
    reply.header("Cache-Control", "no-store");
    return created ? { ...result, secretAvailable: true, key: rawKey } : result;
  });

  app.get("/admin/api/apps/:id/keys", async (request): Promise<ApiKeyListResult> => {
    const session = await admin(request, "apikey.view");
    const owner = await repos.getApiApp(param(request, "id"));
    if (!owner) throw errors.notFound("应用不存在");
    const items = await repos.listApiKeys(owner.id);
    return { items: items.map(key => ({ ...key, created_at: key.created_at.toISOString(), expires_at: key.expires_at?.toISOString() ?? null, last_used_at: key.last_used_at?.toISOString() ?? null })), canManage: hasPermission(session.principal, "apikey.manage") && scopeCoversOrg(await dataScopeFor(session.principal), owner.owner_org_unit_id) };
  });
}
