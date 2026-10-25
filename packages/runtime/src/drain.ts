// r5 §4 graceful drain (ruling 15:39). Every Run executing in this process registers here (runClaimed). Draining
// stops claiming, aborts model calls at once (their step stays running; the next owner marks it MDL-3001 and calls
// again) and lets tool calls finish and store their result; the Run then returns and hands its lease over. After the
// drain limit the remaining Runs are aborted like a lease loss (no result written; the next owner handles the running
// call per §2). The release step then releases the lease of every Run whose tool calls have all ended; a Run with a
// call still running (one that ignored the abort) is not released and its lease expires, so the next owner never
// starts while that call can still have an effect. One handoff per Run, reported to the caller for the run_handoff
// log line.

/** Run handoff after a drain. drained -> released; tool_inflight / release_timeout / release_error -> lease_expiry. */
export type RunHandoff =
  | { runId: string; takeover: "released"; reason: "drained" }
  | { runId: string; takeover: "lease_expiry"; reason: "tool_inflight" | "release_timeout" | "release_error" };

interface Entry {
  runId: string;
  drain: AbortController;
  hardAbort: () => void;
  toolsInFlight: number;
  /** Set by handOff: the Run has returned; this releases its lease. */
  release: (() => Promise<void>) | null;
  /** Resolves whenever the entry changes (handed over, a tool call ended, done). */
  changed: () => void;
  wake: Promise<void>;
  closed: boolean;
}

const entries = new Set<Entry>();
const byRun = new Map<string, Set<Entry>>();
let draining = false;

function rearm(entry: Entry): void {
  entry.wake = new Promise<void>((resolve) => {
    entry.changed = () => {
      resolve();
      rearm(entry);
    };
  });
}

function remove(entry: Entry): void {
  entry.closed = true;
  entries.delete(entry);
  const set = byRun.get(entry.runId);
  set?.delete(entry);
  if (set && set.size === 0) byRun.delete(entry.runId);
}

export function isDraining(): boolean {
  return draining;
}

/** Back to normal (startRuntime): claims allowed again. */
export function resetDrain(): void {
  draining = false;
}

export interface RunRegistration {
  /** Aborts when a drain starts (already aborted when one is in progress). */
  signal: AbortSignal;
  /** Marks a tool call of this Run as executing; call the returned function once it has ended (also after an abort). */
  toolStarted: () => () => void;
  /**
   * The Run has returned during a drain. The drain calls `release` (announce + lease release) once all tool calls
   * of the Run have ended, within the release step; otherwise the lease is left to expire. No-op once the drain is
   * over for this Run.
   */
  handOff: (release: () => Promise<void>) => void;
  /** The Run returned outside a drain and released its lease itself: no handoff. */
  done: () => void;
}

function trackTool(entry: Entry): () => void {
  entry.toolsInFlight += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    entry.toolsInFlight -= 1;
    entry.changed();
  };
}

/** Registers a Run executing here; `hardAbort` is called when the drain limit is reached. */
export function registerRun(runId: string, hardAbort: () => void): RunRegistration {
  const entry: Entry = {
    runId,
    drain: new AbortController(),
    hardAbort,
    toolsInFlight: 0,
    release: null,
    changed: () => undefined,
    wake: Promise.resolve(),
    closed: false,
  };
  rearm(entry);
  if (draining) entry.drain.abort();
  entries.add(entry);
  const set = byRun.get(runId) ?? new Set<Entry>();
  set.add(entry);
  byRun.set(runId, set);
  return {
    signal: entry.drain.signal,
    toolStarted: () => trackTool(entry),
    handOff: (release) => {
      if (entry.closed || entry.release) return;
      entry.release = release;
      entry.changed();
    },
    done: () => {
      if (entry.closed) return;
      remove(entry);
      entry.changed();
    },
  };
}

/** Tool executions (tools.ts) report here by Run id; a no-op for Runs not registered in this process. */
export function toolCallStarted(runId: string): () => void {
  const ends = [...(byRun.get(runId) ?? [])].map(trackTool);
  return () => {
    for (const end of ends) end();
  };
}

export interface DrainOptions {
  /** Cap of the release step (ruling: 1000 ms). */
  releaseMs?: number;
  /** Absolute time (ms) neither step waits past. */
  deadlineAt?: number;
}

export interface DrainResult {
  timedOut: boolean;
  /** Runs still executing when the drain limit was reached (aborted, rows left as they were). */
  runIds: string[];
  /** Duration of the drain step (without the release step). */
  ms: number;
  /** One per Run drained here. */
  handoffs: RunHandoff[];
  /** The release step ended at its limit with Runs still unresolved. */
  releaseTimedOut: boolean;
  /** Limit the release step had (after the deadline cut). */
  releaseMs: number;
}

const DEFAULT_RELEASE_MS = 1000;

function timer(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), Math.max(0, ms));
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

/** Waits until every entry satisfies `ok` (entries that register meanwhile included) or the limit. */
async function waitAll(ok: (entry: Entry) => boolean, limit: Promise<"timeout">): Promise<boolean> {
  for (;;) {
    const pending = [...entries].filter((entry) => !ok(entry));
    if (pending.length === 0) return true;
    const winner = await Promise.race([limit, ...pending.map((entry) => entry.wake.then(() => "changed" as const))]);
    if (winner === "timeout") return false;
  }
}

const handedOver = (entry: Entry) => entry.release !== null;

/**
 * Starts draining (no more claims, Run signals aborted), waits up to `drainMs` for the Runs to return, aborts the
 * rest, then releases the leases that may be released, at most `releaseMs`. Both steps stop at `deadlineAt`.
 */
export async function drainRuns(drainMs: number, options: DrainOptions = {}): Promise<DrainResult> {
  const startedAt = Date.now();
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  const remaining = () => Math.max(0, deadlineAt - Date.now());
  draining = true;
  for (const entry of entries) entry.drain.abort();

  const drainLimit = timer(Math.min(drainMs, remaining()));
  const allReturned = await waitAll(handedOver, drainLimit.promise).finally(drainLimit.cancel);
  let runIds: string[] = [];
  if (!allReturned) {
    const left = [...entries].filter((entry) => !handedOver(entry));
    runIds = [...new Set(left.map((entry) => entry.runId))];
    for (const entry of left) entry.hardAbort();
  }
  const ms = Date.now() - startedAt;

  const releaseMs = Math.min(options.releaseMs ?? DEFAULT_RELEASE_MS, remaining());
  const releaseLimit = timer(releaseMs);
  const outcomes = new Map<Entry, RunHandoff>();
  const releasing: Array<Promise<void>> = [];
  const startRelease = (entry: Entry): void => {
    const release = entry.release!;
    releasing.push((async () => {
      const outcome = await Promise.race([
        Promise.resolve().then(release).then(() => "ok" as const, () => "error" as const),
        releaseLimit.promise,
      ]);
      if (outcome === "ok") outcomes.set(entry, { runId: entry.runId, takeover: "released", reason: "drained" });
      else if (outcome === "error") outcomes.set(entry, { runId: entry.runId, takeover: "lease_expiry", reason: "release_error" });
    })());
  };
  const started = new Set<Entry>();
  const releasable = (entry: Entry) => handedOver(entry) && entry.toolsInFlight === 0;
  // Release each Run as soon as it has returned and all its tool calls ended; stop waiting at the limit.
  for (;;) {
    for (const entry of entries) {
      if (!started.has(entry) && releasable(entry)) {
        started.add(entry);
        startRelease(entry);
      }
    }
    const waiting = [...entries].filter((entry) => !started.has(entry));
    if (waiting.length === 0) break;
    const winner = await Promise.race([releaseLimit.promise, ...waiting.map((entry) => entry.wake.then(() => "changed" as const))]);
    if (winner === "timeout") break;
  }
  await Promise.race([Promise.all(releasing), releaseLimit.promise]);
  releaseLimit.cancel();

  const handoffs: RunHandoff[] = [];
  let releaseTimedOut = false;
  for (const entry of [...entries]) {
    let handoff = outcomes.get(entry);
    if (!handoff) {
      releaseTimedOut = true;
      const reason = entry.toolsInFlight > 0 ? "tool_inflight" : "release_timeout";
      handoff = { runId: entry.runId, takeover: "lease_expiry", reason };
    }
    handoffs.push(handoff);
    remove(entry); // abandoned: a late handOff / release is ignored, the lease expires
  }
  return { timedOut: !allReturned, runIds, ms, handoffs, releaseTimedOut, releaseMs };
}
