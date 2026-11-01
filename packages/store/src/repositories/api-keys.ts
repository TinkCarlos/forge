import type { RowDataPacket } from "mysql2/promise";
import { errors, ForgeError, ulidWithPrefix } from "@forge/core";
import type { ApiKeyRotationResult } from "@forge/contracts";
import { json, parseJsonValue, transaction } from "../db.js";
import { auditRepo } from "./audit.js";

type KeyAudit = { actorId: string; orgUnitId: string | null };
interface LockedKey extends RowDataPacket {
  id: string; app_id: string; name: string; status: string; scopes_json: unknown; expires_at: Date | null;
}

export const apiKeysRepo = {
  async revokeApiKey(id: string, audit: KeyAudit): Promise<void> {
    await transaction(async (conn) => {
      const [rows] = await conn.query<LockedKey[]>("SELECT * FROM api_keys WHERE id = ? FOR UPDATE", [id]);
      const key = rows[0];
      if (!key) throw errors.notFound("密钥不存在");
      if (key.status === "revoked") return;
      await conn.execute("UPDATE api_keys SET status = 'revoked' WHERE id = ?", [id]);
      await auditRepo.audit({ actorType: "user", ...audit, action: "apikey.revoke", resourceType: "api_key", resourceId: id, details: { appId: key.app_id } }, conn);
    });
  },

  async rotateApiKey(input: { id: string; prefix: string; keyHash: string; overlapSeconds: number; idempotencyKey: string; requestHash: string }, audit: KeyAudit): Promise<{ created: boolean; result: ApiKeyRotationResult }> {
    return transaction(async (conn) => {
      // Serialize rotations and revocation before checking replay, including when the old key is now revoked.
      const [rows] = await conn.query<LockedKey[]>("SELECT * FROM api_keys WHERE id = ? FOR UPDATE", [input.id]);
      const old = rows[0];
      if (!old) throw errors.notFound("密钥不存在");
      const scope = `apikey.rotate:${input.id}`;
      const [replays] = await conn.query<RowDataPacket[]>("SELECT id, request_hash, response_json, expires_at > UTC_TIMESTAMP(3) AS unexpired FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?", [scope, input.idempotencyKey]);
      const replay = replays[0];
      if (replay?.unexpired) {
        if (replay.request_hash !== input.requestHash) throw new ForgeError("OPN-4503", { message: "相同 Idempotency-Key 不能用于不同请求", httpStatus: 409, retryable: false });
        const result = parseJsonValue<ApiKeyRotationResult | null>(replay.response_json, null);
        if (!result) throw errors.conflict("轮换记录不可读取，请检查密钥列表");
        return { created: false, result };
      }
      const now = Date.now();
      if (old.status !== "active" || (old.expires_at && old.expires_at.getTime() <= now)) throw errors.conflict("仅能轮换未过期的有效密钥");
      const id = ulidWithPrefix("key");
      const oldExpiresAt = input.overlapSeconds === 0 ? old.expires_at : new Date(Math.min(old.expires_at?.getTime() ?? Infinity, now + input.overlapSeconds * 1000));
      const oldStatus = input.overlapSeconds === 0 ? "revoked" : "active";
      await conn.execute("INSERT INTO api_keys (id, app_id, name, prefix, key_hash, scopes_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, old.app_id, old.name, input.prefix, input.keyHash, json(parseJsonValue(old.scopes_json, [])), old.expires_at]);
      await conn.execute("UPDATE api_keys SET status = ?, expires_at = ? WHERE id = ?", [oldStatus, oldExpiresAt, old.id]);
      const result: ApiKeyRotationResult = { id, prefix: input.prefix, expiresAt: old.expires_at?.toISOString() ?? null, oldKeyId: old.id, oldKeyStatus: oldStatus, oldKeyExpiresAt: oldExpiresAt?.toISOString() ?? null, secretAvailable: false };
      // The old-key lock already serializes this scope; locking a missing replay would gap-lock unrelated keys.
      if (replay) await conn.execute("DELETE FROM idempotency_keys WHERE id = ?", [replay.id]);
      // Persist only metadata, atomically with both keys and audit; plaintext cannot be recovered on replay.
      await conn.execute("INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status_code, response_json, expires_at) VALUES (?, ?, ?, ?, 200, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 24 HOUR))", [ulidWithPrefix("idm"), scope, input.idempotencyKey, input.requestHash, json(result)]);
      await auditRepo.audit({ actorType: "user", ...audit, action: "apikey.rotate", resourceType: "api_key", resourceId: old.id, details: { appId: old.app_id, newKeyId: id, overlapSeconds: input.overlapSeconds, oldKeyExpiresAt: result.oldKeyExpiresAt } }, conn);
      return { created: true, result };
    });
  },
};
