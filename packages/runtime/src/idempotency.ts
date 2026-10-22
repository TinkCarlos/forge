import { ForgeError, sha256 } from "@forge/core";
import { parseJsonValue, repos } from "@forge/store";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stable(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
  }
  return value;
}

export function idempotencyRequestHash(body: unknown): string {
  return sha256(JSON.stringify(stable(body)));
}

export async function resolveIdempotentCreate(input: {
  scope: string;
  key?: string | null;
  requestHash: string;
  create: () => Promise<{ statusCode: number; body: Record<string, unknown>; runId?: string | null }>;
}): Promise<{ statusCode: number; body: Record<string, unknown>; replayed: boolean }> {
  const key = input.key?.trim() ?? "";
  if (!key) {
    const created = await input.create();
    return { statusCode: created.statusCode, body: created.body, replayed: false };
  }
  if (key.length > 200) throw new ForgeError("CFG-8501", "Idempotency-Key 过长", 400);

  const existing = await repos.getIdempotency(input.scope, key);
  if (existing) {
    const expiresAt = existing.expires_at instanceof Date ? existing.expires_at.getTime() : new Date(String(existing.expires_at)).getTime();
    const createdAt = existing.created_at instanceof Date ? existing.created_at.getTime() : new Date(String(existing.created_at)).getTime();
    const inProgress = Number(existing.status_code ?? 0) === 0;
    const stale = inProgress && Date.now() - createdAt > 120_000;
    if (expiresAt > Date.now() && !stale) {
      if (String(existing.request_hash) !== input.requestHash) {
        throw new ForgeError("OPN-4503", "相同 Idempotency-Key 不能用于不同请求", 409);
      }
      if (inProgress) throw new ForgeError("OPN-4503", "相同 Idempotency-Key 正在处理", 409);
      return { statusCode: 200, body: parseJsonValue(existing.response_json, {}), replayed: true };
    }
    await repos.deleteIdempotency(String(existing.id));
  }

  let reservationId = "";
  try {
    reservationId = await repos.reserveIdempotency({ scope: input.scope, key, requestHash: input.requestHash });
  } catch (error) {
    if ((error as { errno?: number }).errno !== 1062) throw error;
    const raced = await repos.getIdempotency(input.scope, key);
    if (!raced) throw error;
    if (String(raced.request_hash) !== input.requestHash) throw new ForgeError("OPN-4503", "相同 Idempotency-Key 不能用于不同请求", 409);
    if (Number(raced.status_code ?? 0) === 0) throw new ForgeError("OPN-4503", "相同 Idempotency-Key 正在处理", 409);
    return { statusCode: 200, body: parseJsonValue(raced.response_json, {}), replayed: true };
  }

  try {
    const created = await input.create();
    if (created.statusCode >= 500) {
      await repos.deleteIdempotency(reservationId);
      return { statusCode: created.statusCode, body: created.body, replayed: false };
    }
    await repos.completeIdempotency(reservationId, { statusCode: created.statusCode, response: created.body, runId: created.runId ?? null });
    return { statusCode: created.statusCode, body: created.body, replayed: false };
  } catch (error) {
    await repos.deleteIdempotency(reservationId);
    throw error;
  }
}
