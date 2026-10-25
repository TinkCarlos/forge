// r5 §4 graceful drain. Every Run executing in this process registers here (runClaimed). Draining stops claiming,
// aborts model calls at once (their step stays running; the next owner marks it MDL-3001 and calls again) and lets
// tool calls finish and store their result; the Run then returns and releases its lease. After the drain timeout the
// remaining Runs are aborted like a lease loss (no result written; the next owner handles the running call per §2).

interface Entry {
  runId: string;
  drain: AbortController;
  hardAbort: () => void;
  settled: Promise<void>;
  settle: () => void;
}

const entries = new Set<Entry>();
let draining = false;

export function isDraining(): boolean {
  return draining;
}

/** Back to normal (startRuntime): claims allowed again. */
export function resetDrain(): void {
  draining = false;
}

/**
 * Registers a Run executing here. `signal` aborts when a drain starts (already aborted when one is in progress);
 * `hardAbort` is called when the drain times out. Call `done` once the Run has returned and released its lease.
 */
export function registerRun(runId: string, hardAbort: () => void): { signal: AbortSignal; done: () => void } {
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const entry: Entry = { runId, drain: new AbortController(), hardAbort, settled, settle };
  if (draining) entry.drain.abort();
  entries.add(entry);
  return {
    signal: entry.drain.signal,
    done: () => {
      entries.delete(entry);
      entry.settle();
    },
  };
}

export interface DrainResult {
  timedOut: boolean;
  /** Runs still executing when the drain timed out (aborted, rows left as they were). */
  runIds: string[];
  ms: number;
}

/** After the hard abort, how long the aborted Runs get to release their lease (best effort) before we return. */
const RELEASE_GRACE_MS = 2000;

function wait(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function settledWithin(ms: number): Promise<boolean> {
  const all = Promise.all([...entries].map((entry) => entry.settled)).then(() => true);
  const timer = wait(ms);
  try {
    return await Promise.race([all, timer.promise.then(() => false)]);
  } finally {
    timer.cancel();
  }
}

/** Starts draining (no more claims, Run signals aborted) and waits up to `timeoutMs` for the Runs to return. */
export async function drainRuns(timeoutMs: number): Promise<DrainResult> {
  const startedAt = Date.now();
  draining = true;
  for (const entry of entries) entry.drain.abort();
  if (await settledWithin(timeoutMs)) return { timedOut: false, runIds: [], ms: Date.now() - startedAt };
  const left = [...entries];
  const runIds = [...new Set(left.map((entry) => entry.runId))];
  for (const entry of left) entry.hardAbort();
  await settledWithin(RELEASE_GRACE_MS);
  return { timedOut: true, runIds, ms: Date.now() - startedAt };
}
