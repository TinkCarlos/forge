import os from "node:os";
import { config } from "@forge/core";
import { repos, type ClaimedRun } from "@forge/store";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "budget_exhausted"]);

export function currentWorkerId(): string {
  return `${os.hostname()}:${process.pid}`.slice(0, 128);
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
