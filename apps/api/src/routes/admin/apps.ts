import { randomBytes } from "node:crypto";
import { type FastifyInstance } from "fastify";
import { config, encryptSecret, errors, hashApiKey } from "@forge/core";
import { deliverDueWebhooks } from "@forge/runtime";
import { repos } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  arrayBody,
  admin,
  writeAudit,
  requireBodyString,
} from "../../plugins/http-helpers.js";

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
        nextAttemptAt: item.next_attempt_at,
        deliveredAt: item.delivered_at,
        createdAt: item.created_at,
      })),
    };
  });

  app.post("/admin/api/webhook-deliveries/:id/replay", async (request) => {
    const session = await admin(request, "apikey.manage");
    const delivery = await repos.getWebhookDelivery(param(request, "id"));
    if (!delivery) throw errors.notFound("投递记录不存在");
    const replayed = await repos.replayWebhookDelivery(String(delivery.id));
    if (!replayed) throw errors.conflict("投递记录无法重放");
    await writeAudit(session, "webhook.replay", "webhook_delivery", String(delivery.id), { eventId: delivery.event_id });
    await deliverDueWebhooks();
    const fresh = await repos.getWebhookDelivery(String(delivery.id));
    return { ok: true, status: fresh?.status ?? "pending" };
  });

  app.get("/admin/api/apps", async (request) => {
    await admin(request, "apikey.view");
    const apps = await repos.listApiApps();
    return {
      items: apps.map((app) => ({
        id: app.id,
        key: app.key,
        name: app.name,
        status: app.status,
        scopes: app.scopes_json,
        webhookUrl: app.webhook_url,
        rateLimitPerMinute: app.rate_limit_per_minute,
        dailyQuota: app.daily_quota,
        createdAt: app.created_at,
      })),
    };
  });

  app.post("/admin/api/apps", async (request) => {
    const session = await admin(request, "apikey.manage");
    const body = bodyOf(request);
    const key = requireBodyString(body, "key");
    const webhookSecret = stringBody(body, "webhookSecret");
    const appId = await repos.createApiApp({
      key,
      name: stringBody(body, "name", key),
      description: stringBody(body, "description"),
      ownerOrgUnitId: session.principal.orgUnitId,
      scopes: arrayBody(body, "scopes").length ? arrayBody(body, "scopes") : ["agents:read", "runs:create", "runs:read", "runs:cancel"],
      webhookUrl: stringBody(body, "webhookUrl") || null,
      webhookSecretEncrypted: webhookSecret ? encryptSecret(webhookSecret, config.FORGE_MASTER_KEY) : null,
      rateLimitPerMinute: Number(body.rateLimitPerMinute ?? 60),
      dailyQuota: Number(body.dailyQuota ?? 1000),
      createdBy: session.principal.id,
    });
    await writeAudit(session, "app.create", "api_app", appId, { key });
    return { id: appId };
  });

  app.patch("/admin/api/apps/:id", async (request) => {
    const session = await admin(request, "apikey.manage");
    const app = await repos.getApiApp(param(request, "id"));
    if (!app) throw errors.notFound("应用不存在");
    const body = bodyOf(request);
    const fields: Record<string, unknown> = {};
    if (body.name !== undefined) fields.name = stringBody(body, "name");
    if (body.description !== undefined) fields.description = stringBody(body, "description");
    if (body.status !== undefined) fields.status = stringBody(body, "status");
    if (body.scopes !== undefined) fields.scopes_json = arrayBody(body, "scopes");
    if (body.webhookUrl !== undefined) fields.webhook_url = stringBody(body, "webhookUrl") || null;
    if (body.webhookSecret) fields.webhook_secret_encrypted = encryptSecret(stringBody(body, "webhookSecret"), config.FORGE_MASTER_KEY);
    if (body.rateLimitPerMinute !== undefined) fields.rate_limit_per_minute = Number(body.rateLimitPerMinute);
    if (body.dailyQuota !== undefined) fields.daily_quota = Number(body.dailyQuota);
    await repos.updateApiApp(String(app.id), fields);
    await writeAudit(session, "app.update", "api_app", String(app.id), { name: fields.name, status: fields.status });
    return { ok: true };
  });

  app.post("/admin/api/apps/:id/keys", async (request) => {
    const session = await admin(request, "apikey.manage");
    const app = await repos.getApiApp(param(request, "id"));
    if (!app) throw errors.notFound("应用不存在");
    const body = bodyOf(request);
    const rawKey = `fsk_${randomBytes(32).toString("base64url")}`;
    const prefix = rawKey.slice(0, 16);
    const keyId = await repos.createApiKey({
      appId: String(app.id),
      name: stringBody(body, "name", "default"),
      prefix,
      keyHash: hashApiKey(rawKey, config.API_KEY_PEPPER),
      scopes: Array.isArray(app.scopes_json) ? (app.scopes_json as string[]) : [],
    });
    await writeAudit(session, "apikey.create", "api_key", keyId, { appId: app.id });
    return { id: keyId, key: rawKey, prefix, warning: "此密钥只显示一次，请立即保存" };
  });

  app.get("/admin/api/apps/:id/keys", async (request) => {
    await admin(request, "apikey.view");
    return { items: await repos.listApiKeys(param(request, "id")) };
  });
}
