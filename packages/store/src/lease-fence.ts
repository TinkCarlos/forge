import { AsyncLocalStorage } from "node:async_hooks";

/**
 * P3-09 (architect ruling 1): lease fence for the writes of a claimed Run. Inside withRunLease(runId, owner, fn) every
 * run-scoped write of the runs repository for that Run carries the lease holder condition `runs.claimed_by = owner`
 * (the K-34 conditional-UPDATE pattern). A write that affects 0 rows because another worker holds the lease is
 * discarded and throws LeaseLostError. Writes outside a scope (admin paths) and writes for another Run are not fenced.
 * The lease holder column is runs.claimed_by.
 */
export class LeaseLostError extends Error {
  constructor() {
    super("run lease lost");
    this.name = "LeaseLostError";
  }
}

export type LeaseScope = { runId: string; owner: string };

const storage = new AsyncLocalStorage<LeaseScope>();

export function withRunLease<T>(runId: string, owner: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ runId, owner }, fn);
}

/** The active lease scope, if any (for diagnostics and tests). */
export function leaseScope(): LeaseScope | undefined {
  return storage.getStore();
}

/** The lease owner to enforce for a write on runId, or null when the write is not fenced. */
export function fenceOwnerFor(runId: string): string | null {
  const scope = storage.getStore();
  return scope && scope.runId === runId ? scope.owner : null;
}

/** The active scope when any write keyed by a child row (tool call, step) must be fenced. */
export function activeFence(): LeaseScope | null {
  return storage.getStore() ?? null;
}
