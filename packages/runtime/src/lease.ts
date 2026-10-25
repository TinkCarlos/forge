import { randomBytes } from "node:crypto";
import os from "node:os";
import { config } from "@forge/core";
import { repos, type ClaimedRun } from "@forge/store";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "budget_exhausted"]);

/** r5 §5: generated once per process, so a restart that reuses host+pid (container pid 1) is a different owner. */
const PROCESS_EPOCH = randomBytes(4).toString("hex");

/** `hostname:pid:epoch`, at most 128 chars (runs.claimed_by); the hostname is cut first, pid and epoch are kept. */
export function currentWorkerId(): string {
  const tail = `:${process.pid}:${PROCESS_EPOCH}`;
  return `${os.hostname().slice(0, Math.max(0, 128 - tail.length))}${tail}`;
}

export function leaseEligible(input: {
  status: string;
  claimedBy: string | null;
  leaseExpiresAt: Date | null;
  workerId: string;
  now: Date;
  allowWaiting: boolean;
}): boolean {
  if (TERMINAL.has(input.status)) return false;
  if (input.status === "queued") return true;
  if (input.status === "waiting_approval") return input.allowWaiting;
  if (input.status !== "running") return false;
  if (!input.claimedBy || !input.leaseExpiresAt) return true;
  return input.leaseExpiresAt.getTime() < input.now.getTime();
}

export async function claimNext(workerId: string): Promise<ClaimedRun | null> {
  return repos.claimNextRun(workerId, config.LEASE_TTL_SECONDS);
}

export async function claimRun(runId: string, workerId: string, allowWaiting: boolean): Promise<ClaimedRun | null> {
  return repos.claimRun(runId, workerId, config.LEASE_TTL_SECONDS, allowWaiting);
}
