import { config } from "@forge/core";
import { repos, type ClaimedRun } from "@forge/store";
import { AUTH_GC_INTERVAL_MS, collectExpiredAuth } from "./auth-gc.js";
import { drainRuns, isDraining, resetDrain, type DrainOptions, type DrainResult } from "./drain.js";
import { claimNext, claimRun, currentWorkerId } from "./lease.js";
import { leaseTiming } from "./lease-timing.js";
import { finishCancelRequestedRun, runClaimed } from "./loop.js";
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
export async function claimRuns(workerId: string): Promise<void> {
  while (active < config.MAX_CONCURRENT_RUNS && !isDraining()) {
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
  if (room <= 0 || isDraining()) return;
  const runIds = await repos.listRunsWithExpiredApprovals(room);
  for (const runId of runIds) {
    if (active >= config.MAX_CONCURRENT_RUNS || isDraining()) break;
    const claimed = await claimRun(runId, workerId, true);
    if (claimed) launch(claimed, workerId);
  }
}

/** r6 cancel sweep: at most this many cancel-requested Runs are finished per worker cycle. */
export const CANCEL_SWEEP_BATCH = 20;

/**
 * r6 cancel sweep, once per worker cycle after the expiry sweep: a Run whose cancel is committed but that nobody
 * executes (queued or waiting_approval with cancel_requested, lease free; e.g. the cancel's own finalize failed) is
 * finished as cancelled with the terminal rules (finishCancelRequestedRun: pending approvals expired in the same
 * transaction, approval.resolved before run.cancelled, nothing when the lease is lost). Runs are finished inline (not
 * launched), so the MAX_CONCURRENT_RUNS budget is not used; skipped while draining.
 */
export async function sweepCancelRequestedRuns(workerId: string): Promise<void> {
  if (isDraining()) return;
  const runIds = await repos.listCancelRequestedRuns(CANCEL_SWEEP_BATCH);
  for (const runId of runIds) {
    if (isDraining()) break;
    await finishCancelRequestedRun(runId, workerId);
  }
}

export function startRuntime(): void {
  if (workerTimer) return;
  leaseTiming(config.LEASE_TTL_SECONDS);
  resetDrain(); // P3-09: a TTL leaving no heartbeat tolerance fails at startup
  const workerId = currentWorkerId();
  // K-20 / OPS-010: all ticks share guardTick (catch + log + exponential backoff 1s..30s, reset on success).
  const webhookTick: GuardedTick = guardTick("webhook", () => deliverDueWebhooks());
  const workerTick: GuardedTick = guardTick("worker", async () => {
    await claimRuns(workerId);
    await sweepExpiredApprovals(workerId);
    await sweepCancelRequestedRuns(workerId);
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

/**
 * r5 §4 graceful drain (API with the embedded worker and the standalone worker): stop the ticks and claiming, abort
 * model calls, let tool calls finish, at most `timeoutMs` (WORKER_DRAIN_TIMEOUT_MS; the API caps it at 5000). On
 * timeout the remaining Runs are aborted (rows left as they are) and `timedOut` is true: the caller logs
 * phase=run_drain_timeout and exits 1 after its normal close. Then the release step (ruling 15:39, at most
 * `releaseMs`, default 1000): a Run whose tool calls have all ended gets `run.released {reason:"drain"}` and its lease
 * released; the others keep the lease until it expires. `handoffs` has one entry per Run for the run_handoff lines.
 */
export async function drainRuntime(timeoutMs: number = config.WORKER_DRAIN_TIMEOUT_MS, options: DrainOptions = {}): Promise<DrainResult> {
  stopRuntime();
  return drainRuns(timeoutMs, options);
}
