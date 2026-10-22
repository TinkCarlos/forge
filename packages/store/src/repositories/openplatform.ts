import { ulidWithPrefix } from "@forge/core";
import { execute, json, one, query } from "../db.js";

export const openPlatformRepo = {
  // API apps / keys
  async listApiApps(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM api_apps ORDER BY created_at DESC");
  },
  async getApiApp(id: string): Promise<Record<string, unknown> | null> {
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
    rateLimitPerMinute?: number;
    dailyQuota?: number;
    createdBy?: string | null;
  }): Promise<string> {
    const id = ulidWithPrefix("app");
    await execute(
      `INSERT INTO api_apps (id, \`key\`, name, description, owner_org_unit_id, scopes_json, webhook_url, webhook_secret_encrypted, rate_limit_per_minute, daily_quota, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.key,
        input.name,
        input.description ?? "",
        input.ownerOrgUnitId ?? null,
        json(input.scopes),
        input.webhookUrl ?? null,
        input.webhookSecretEncrypted ?? null,
        input.rateLimitPerMinute ?? 60,
        input.dailyQuota ?? 1000,
        input.createdBy ?? null,
      ],
    );
    return id;
  },
  async updateApiApp(id: string, fields: Record<string, unknown>): Promise<void> {
    const allowed = ["name", "description", "status", "scopes_json", "webhook_url", "webhook_secret_encrypted", "rate_limit_per_minute", "daily_quota"];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      sets.push(`\`${key}\` = ?`);
      params.push(key.endsWith("_json") ? json(value) : value);
    }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE api_apps SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async createApiKey(input: { appId: string; name: string; prefix: string; keyHash: string; scopes: string[]; expiresAt?: Date | null }): Promise<string> {
    const id = ulidWithPrefix("key");
    await execute(
      "INSERT INTO api_keys (id, app_id, name, prefix, key_hash, scopes_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, input.appId, input.name, input.prefix, input.keyHash, json(input.scopes), input.expiresAt ?? null],
    );
    return id;
  },
  async listApiKeys(appId: string): Promise<Record<string, unknown>[]> {
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
  async finishWebhookDelivery(id: string, input: { status: "delivered" | "failed"; responseStatus?: number | null; errorMessage?: string | null }): Promise<void> {
    await execute(
      "UPDATE webhook_deliveries SET status = ?, response_status = ?, error_message = ?, delivered_at = IF(? = 'delivered', UTC_TIMESTAMP(3), delivered_at) WHERE id = ?",
      [input.status, input.responseStatus ?? null, input.errorMessage ?? null, input.status, id],
    );
  },
  async scheduleWebhookRetry(id: string, delayMs: number, responseStatus: number | null, errorMessage: string | null): Promise<void> {
    const seconds = Math.max(1, Math.ceil(delayMs / 1000));
    await execute(
      `UPDATE webhook_deliveries SET status = 'pending', response_status = ?, error_message = ?, next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${seconds} SECOND) WHERE id = ?`,
      [responseStatus, errorMessage, id],
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
      "UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = UTC_TIMESTAMP(3), error_message = NULL, delivered_at = NULL WHERE id = ?",
      [id],
    );
    return result.affectedRows === 1;
  },
};
