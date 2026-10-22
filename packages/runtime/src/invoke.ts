import { repos, type RunRow } from "@forge/store";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "budget_exhausted"]);

export function clampWaitSeconds(value: unknown, fallback = 30): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(120, Math.max(1, Math.floor(parsed)));
}

export function invokeStatusCode(runStatus: string): 200 | 202 {
  return TERMINAL.has(runStatus) ? 200 : 202;
}

export async function waitForRun(runId: string, waitSeconds: number): Promise<{ run: RunRow | null; timedOut: boolean }> {
  const deadline = Date.now() + clampWaitSeconds(waitSeconds, 30) * 1000;
  while (true) {
    const run = await repos.getRun(runId);
    if (!run) return { run: null, timedOut: false };
    if (TERMINAL.has(run.status)) return { run, timedOut: false };
    if (Date.now() >= deadline) return { run, timedOut: true };
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(1, remaining))));
  }
}
