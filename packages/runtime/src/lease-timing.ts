import { ForgeError } from "@forge/core/errors";
/**
 * P3-09 (architect ruling 1): heartbeat timing for a claimed Run. The heartbeat runs every max(1s, TTL/3). When a
 * heartbeat errors (DB unreachable) the worker keeps running only until LEASE_TTL_SECONDS - heartbeat interval has
 * passed since the last confirmed renewal, i.e. at least one interval before the lease can expire and another worker
 * can reclaim the Run. That difference must be > 0: a TTL leaving no tolerance is a configuration error and throws
 * (startRuntime fails at startup).
 */
export function leaseTiming(ttlSeconds: number): { intervalMs: number; toleranceMs: number } {
  const ttlMs = ttlSeconds * 1000;
  const intervalMs = Math.max(1000, Math.floor(ttlMs / 3));
  const toleranceMs = ttlMs - intervalMs;
  if (!Number.isFinite(toleranceMs) || toleranceMs <= 0) {
    throw new ForgeError("CFG-8501", { message: `LEASE_TTL_SECONDS=${ttlSeconds} 过小：租约时长减去心跳间隔（${intervalMs}ms）必须大于 0，请至少设为 2` });
  }
  return { intervalMs, toleranceMs };
}
