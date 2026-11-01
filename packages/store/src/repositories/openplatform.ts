import { initializeCredentialBindings, resourceCredentialChanges } from "../credential-bindings.js";
import { updateConfiguration, type ConfigurationWrite, type ConfigurationAudit } from "../configuration-revision.js";
import { ulidWithPrefix } from "@forge/core";
import { execute, json, one, query, transaction } from "../db.js";
import { auditRepo } from "./audit.js";
import type { ApiAppRow, ApiKeyMetadataRow } from "../types.js";

export const openPlatformRepo = {
  // API apps / keys
  async listApiApps(): Promise<ApiAppRow[]> {
    return query("SELECT * FROM api_apps ORDER BY created_at DESC");
  },
  async getApiApp(id: string): Promise<ApiAppRow | null> {
    return one("SELECT * FROM api_apps WHERE id = ?", [id]);
  },
  async createApiApp(input: {
    key: string;
    name: string;
    description?: string;
    ownerOrgUnitId?: string | null;
    scopes: string[];
    webhookUrl?: string | null;
    webhookSecretEncrypted?: string | null;
    webhookSecret?: string | null;
    webhookSecretId?: string | null;
    rateLimitPerMinute?: number;
    dailyQuota?: number;
    createdBy?: string | null;
  }, audit?: ConfigurationAudit): Promise<string> {
    const id = ulidWithPrefix("app");
    await transaction(async conn => {
      await conn.execute(`INSERT INTO api_apps (id, \`key\`, name, description, owner_org_unit_id, scopes_json, webhook_url, rate_limit_per_minute, daily_quota, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, input.key, input.name, input.description ?? "", input.ownerOrgUnitId ?? null, json(input.scopes), input.webhookUrl ?? null, input.rateLimitPerMinute ?? 60, input.dailyQuota ?? 1000, input.createdBy ?? null]);
      await initializeCredentialBindings(conn, { type: "api_app", id, name: input.name, orgUnitId: input.ownerOrgUnitId ?? null, createdBy: input.createdBy ?? null }, { value: input.webhookSecret, secretId: input.webhookSecretId, legacyEncrypted: input.webhookSecretEncrypted }, audit);
      if (audit) await auditRepo.audit({ ...audit, resourceId: id }, conn);
    });
    return id;
  },
  async updateApiApp(id: string, fields: Record<string, unknown>, options: ConfigurationWrite): Promise<number> {
    const allowed = ["name", "description", "status", "scopes_json", "webhook_url", "rate_limit_per_minute", "daily_quota"];
    const values = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.includes(key)).map(([key, value]) => [key, key.endsWith("_json") ? json(value) : value]));
    return updateConfiguration("api_apps", id, async conn => ({ ...values, ...await resourceCredentialChanges("api_app", id, fields, conn, options.audit) }), options);
  },
  async createApiKey(input: { appId: string; name: string; prefix: string; keyHash: string; scopes: string[]; expiresAt?: Date | null }, audit?: { actorId: string; orgUnitId: string | null }): Promise<string> {
    const id = ulidWithPrefix("key");
    await transaction(async (conn) => {
      await conn.execute(
        "INSERT INTO api_keys (id, app_id, name, prefix, key_hash, scopes_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, input.appId, input.name, input.prefix, input.keyHash, json(input.scopes), input.expiresAt ?? null],
      );
      if (audit) await auditRepo.audit({ actorType: "user", ...audit, action: "apikey.create", resourceType: "api_key", resourceId: id, details: { appId: input.appId, expiresAt: input.expiresAt ?? null } }, conn);
    });
    return id;
  },
  async getApiKeyOwner(id: string): Promise<{ app_id: string; owner_org_unit_id: string | null } | null> {
    return one("SELECT k.app_id, a.owner_org_unit_id FROM api_keys k JOIN api_apps a ON a.id = k.app_id WHERE k.id = ?", [id]);
  },
  async listApiKeys(appId: string): Promise<ApiKeyMetadataRow[]> {
    return query("SELECT id, app_id, name, prefix, scopes_json, status, expires_at, last_used_at, created_at FROM api_keys WHERE app_id = ? ORDER BY created_at DESC", [appId]);
  },
  async findApiKeyByPrefix(prefix: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM api_keys WHERE prefix = ? AND status = 'active'", [prefix]);
  },
  async touchApiKey(id: string): Promise<void> {
    await execute("UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [id]);
  },
  async countAppRunsToday(appId: string): Promise<number> {
    const row = await one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM runs WHERE app_id = ? AND created_at >= CURRENT_DATE()",
      [appId],
    );
    return Number(row?.count ?? 0);
  },
  /**
   * Seconds from now to 00:00 of the next day in the DB session time zone, i.e. when countAppRunsToday's
   * CURRENT_DATE() window resets. Computed by MySQL so app and DB time zones cannot disagree; null if unavailable.
   */
  async secondsUntilNextDbDay(): Promise<number | null> {
    const row = await one<{ s: number | string | null }>("SELECT TIMESTAMPDIFF(SECOND, NOW(), CURRENT_DATE() + INTERVAL 1 DAY) AS s");
    const seconds = Number(row?.s);
    return row?.s === null || row?.s === undefined || !Number.isFinite(seconds) ? null : seconds;
  },
  async getIdempotency(scope: string, key: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?", [scope, key]);
  },
  async deleteIdempotency(id: string): Promise<void> {
    await execute("DELETE FROM idempotency_keys WHERE id = ?", [id]);
  },
  async reserveIdempotency(input: { scope: string; key: string; requestHash: string }): Promise<string> {
    const id = ulidWithPrefix("idm");
    await execute(
      "INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status_code, expires_at) VALUES (?, ?, ?, ?, 0, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 24 HOUR))",
      [id, input.scope, input.key, input.requestHash],
    );
    return id;
  },
  async completeIdempotency(id: string, input: { statusCode: number; response: unknown; runId?: string | null }): Promise<void> {
    await execute(
      "UPDATE idempotency_keys SET status_code = ?, response_json = ?, run_id = ?, expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 24 HOUR) WHERE id = ?",
      [input.statusCode, json(input.response), input.runId ?? null, id],
    );
  },
  async enqueueWebhook(input: { appId: string; eventId: string; eventType: string; payload: unknown }): Promise<string | null> {
    const existing = await one<{ id: string }>("SELECT id FROM webhook_deliveries WHERE app_id = ? AND event_id = ?", [input.appId, input.eventId]);
    if (existing) return existing.id;
    const id = ulidWithPrefix("dlv");
    try {
      await execute(
        "INSERT INTO webhook_deliveries (id, app_id, event_id, event_type, payload_json, next_attempt_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))",
        [id, input.appId, input.eventId, input.eventType, json(input.payload)],
      );
      return id;
    } catch (error) {
      if ((error as { errno?: number }).errno !== 1062) throw error;
      const raced = await one<{ id: string }>("SELECT id FROM webhook_deliveries WHERE app_id = ? AND event_id = ?", [input.appId, input.eventId]);
      return raced?.id ?? null;
    }
  },
  async dueWebhookDeliveries(limit = 20): Promise<Record<string, unknown>[]> {
    return query(
      "SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= UTC_TIMESTAMP(3) ORDER BY next_attempt_at LIMIT ?",
      [Math.min(Math.max(limit, 1), 50)],
    );
  },
  async claimWebhookDelivery(id: string, attempts: number): Promise<boolean> {
    const result = await execute(
      "UPDATE webhook_deliveries SET attempts = attempts + 1, next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 60 SECOND) WHERE id = ? AND status = 'pending' AND attempts = ? AND next_attempt_at <= UTC_TIMESTAMP(3)",
      [id, attempts],
    );
    return result.affectedRows === 1;
  },
  async finishWebhookDelivery(id: string, input: { status: "delivered" | "failed"; responseStatus?: number | null; errorMessage?: string | null; errorCode?: string | null }): Promise<void> {
    await execute(
      "UPDATE webhook_deliveries SET status = ?, response_status = ?, error_message = ?, error_code = ?, delivered_at = IF(? = 'delivered', UTC_TIMESTAMP(3), delivered_at) WHERE id = ?",
      [input.status, input.responseStatus ?? null, input.errorMessage ?? null, input.errorCode ?? null, input.status, id],
    );
  },
  async scheduleWebhookRetry(id: string, delayMs: number, responseStatus: number | null, errorMessage: string | null, errorCode: string | null = null): Promise<void> {
    const seconds = Math.max(1, Math.ceil(delayMs / 1000));
    await execute(
      `UPDATE webhook_deliveries SET status = 'pending', response_status = ?, error_message = ?, error_code = ?, next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${seconds} SECOND) WHERE id = ?`,
      [responseStatus, errorMessage, errorCode, id],
    );
  },
  async getWebhookDelivery(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM webhook_deliveries WHERE id = ?", [id]);
  },
  async listWebhookDeliveries(appId: string): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM webhook_deliveries WHERE app_id = ? ORDER BY created_at DESC LIMIT 50", [appId]);
  },
  async replayWebhookDelivery(id: string): Promise<boolean> {
    const result = await execute(
      "UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = UTC_TIMESTAMP(3), error_message = NULL, error_code = NULL, delivered_at = NULL WHERE id = ?",
      [id],
    );
    return result.affectedRows === 1;
  },
};
