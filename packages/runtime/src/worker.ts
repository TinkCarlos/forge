import { config } from "@forge/core";
import { repos, type ClaimedRun } from "@forge/store";
import { AUTH_GC_INTERVAL_MS, collectExpiredAuth } from "./auth-gc.js";
import { claimNext, claimRun, currentWorkerId } from "./lease.js";
import { leaseTiming } from "./lease-timing.js";
import { runClaimed } from "./loop.js";
import { tickSchedules } from "./schedules.js";
import { describeTickError, guardTick, type GuardedTick } from "./tick-guard.js";
import { deliverDueWebhooks } from "./webhook.js";

let workerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let authGcTimer: ReturnType<typeof setInterval> | null = null;
let active = 0;

function launch(claimed: ClaimedRun, workerId: string): void {
  active += 1;
  // runClaimed can reject during a DB outage (emit / getRun / releaseRunLease); never leave that unhandled.
  void runClaimed(claimed, workerId)
    .catch((error) => console.error(`Run ${claimed.run.id} execution failed: ${describeTickError(error)}`))
    .finally(() => {
      active -= 1;
    });
}

/** Claims queued runs up to MAX_CONCURRENT_RUNS. Errors propagate to the tick guard (logged + backoff). */
async function claimRuns(workerId: string): Promise<void> {
  while (active < config.MAX_CONCURRENT_RUNS) {
    const claimed = await claimNext(workerId);
    if (!claimed) break;
    launch(claimed, workerId);
  }
}

/**
 * r5 §2.3 expiry sweep, once per worker cycle after claimRuns: a waiting Run whose approval expired is woken (claimed
 * allowing waiting_approval) so settleToolCalls treats the expiry as a rejection, or fails the Run past the grace
 * period. Shares the MAX_CONCURRENT_RUNS budget; a Run another worker claimed first is skipped.
 */
export async function sweepExpiredApprovals(workerId: string): Promise<void> {
  const room = config.MAX_CONCURRENT_RUNS - active;
  if (room <= 0) return;
  const runIds = await repos.listRunsWithExpiredApprovals(room);
  for (const runId of runIds) {
    if (active >= config.MAX_CONCURRENT_RUNS) break;
    const claimed = await claimRun(runId, workerId, true);
    if (claimed) launch(claimed, workerId);
  }
}

export function startRuntime(): void {
  if (workerTimer) return;
  leaseTiming(config.LEASE_TTL_SECONDS); // P3-09: a TTL leaving no heartbeat tolerance fails at startup
  const workerId = currentWorkerId();
  // K-20 / OPS-010: all ticks share guardTick (catch + log + exponential backoff 1s..30s, reset on success).
  const webhookTick: GuardedTick = guardTick("webhook", () => deliverDueWebhooks());
  const workerTick: GuardedTick = guardTick("worker", async () => {
    await claimRuns(workerId);
    await sweepExpiredApprovals(workerId);
  });
  const scheduleTick: GuardedTick = guardTick("schedules", () => tickSchedules());
  // Session store (007): expired session / OIDC state rows, every 10 min, single runner via GET_LOCK.
  const authGcTick: GuardedTick = guardTick("auth-gc", async () => {
    await collectExpiredAuth();
  });
  const workerCycle = async (): Promise<void> => {
    await webhookTick.run();
    await workerTick.run();
  };
  workerTimer = setInterval(() => void workerCycle(), config.WORKER_POLL_MS);
  schedulerTimer = setInterval(() => void scheduleTick.run(), config.SCHEDULER_POLL_MS);
  authGcTimer = setInterval(() => void authGcTick.run(), AUTH_GC_INTERVAL_MS);
  void workerCycle();
  console.log(`Runtime started (poll ${config.WORKER_POLL_MS}ms, concurrency ${config.MAX_CONCURRENT_RUNS}, lease ${config.LEASE_TTL_SECONDS}s)`);
}

export function stopRuntime(): void {
  if (workerTimer) clearInterval(workerTimer);
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (authGcTimer) clearInterval(authGcTimer);
  workerTimer = null;
  schedulerTimer = null;
  authGcTimer = null;
}
