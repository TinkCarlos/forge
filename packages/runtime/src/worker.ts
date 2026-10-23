import { config } from "@forge/core";
import { claimNext, currentWorkerId } from "./lease.js";
import { runClaimed } from "./loop.js";
import { tickSchedules } from "./schedules.js";
import { describeTickError, guardTick, type GuardedTick } from "./tick-guard.js";
import { deliverDueWebhooks } from "./webhook.js";

let workerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let active = 0;

/** Claims queued runs up to MAX_CONCURRENT_RUNS. Errors propagate to the tick guard (logged + backoff). */
async function claimRuns(workerId: string): Promise<void> {
  while (active < config.MAX_CONCURRENT_RUNS) {
    const claimed = await claimNext(workerId);
    if (!claimed) break;
    active += 1;
    // runClaimed can reject during a DB outage (emit / getRun / releaseRunLease); never leave that unhandled.
    void runClaimed(claimed, workerId)
      .catch((error) => console.error(`Run ${claimed.run.id} execution failed: ${describeTickError(error)}`))
      .finally(() => {
        active -= 1;
      });
  }
}

export function startRuntime(): void {
  if (workerTimer) return;
  const workerId = currentWorkerId();
  // K-20 / OPS-010: all ticks share guardTick (catch + log + exponential backoff 1s..30s, reset on success).
  const webhookTick: GuardedTick = guardTick("webhook", () => deliverDueWebhooks());
  const workerTick: GuardedTick = guardTick("worker", () => claimRuns(workerId));
  const scheduleTick: GuardedTick = guardTick("schedules", () => tickSchedules());
  const workerCycle = async (): Promise<void> => {
    await webhookTick.run();
    await workerTick.run();
  };
  workerTimer = setInterval(() => void workerCycle(), config.WORKER_POLL_MS);
  schedulerTimer = setInterval(() => void scheduleTick.run(), config.SCHEDULER_POLL_MS);
  void workerCycle();
  console.log(`Runtime started (poll ${config.WORKER_POLL_MS}ms, concurrency ${config.MAX_CONCURRENT_RUNS}, lease ${config.LEASE_TTL_SECONDS}s)`);
}

export function stopRuntime(): void {
  if (workerTimer) clearInterval(workerTimer);
  if (schedulerTimer) clearInterval(schedulerTimer);
  workerTimer = null;
  schedulerTimer = null;
}
