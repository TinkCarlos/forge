import { config } from "@forge/core";
import { claimNext, currentWorkerId } from "./lease.js";
import { runClaimed } from "./loop.js";
import { tickSchedules } from "./schedules.js";
import { deliverDueWebhooks } from "./webhook.js";

let workerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let claiming = false;
let active = 0;

async function tickWorker(workerId: string): Promise<void> {
  if (claiming) return;
  claiming = true;
  try {
    await deliverDueWebhooks().catch((error) => console.error("Webhook tick failed", error));
    while (active < config.MAX_CONCURRENT_RUNS) {
      const claimed = await claimNext(workerId);
      if (!claimed) break;
      active += 1;
      void runClaimed(claimed, workerId).finally(() => {
        active -= 1;
      });
    }
  } catch (error) {
    console.error("Worker tick failed", error);
  } finally {
    claiming = false;
  }
}

export function startRuntime(): void {
  if (workerTimer) return;
  const workerId = currentWorkerId();
  workerTimer = setInterval(() => void tickWorker(workerId), config.WORKER_POLL_MS);
  schedulerTimer = setInterval(() => void tickSchedules(), config.SCHEDULER_POLL_MS);
  void tickWorker(workerId);
  console.log(`Runtime started (poll ${config.WORKER_POLL_MS}ms, concurrency ${config.MAX_CONCURRENT_RUNS}, lease ${config.LEASE_TTL_SECONDS}s)`);
}

export function stopRuntime(): void {
  if (workerTimer) clearInterval(workerTimer);
  if (schedulerTimer) clearInterval(schedulerTimer);
  workerTimer = null;
  schedulerTimer = null;
}
