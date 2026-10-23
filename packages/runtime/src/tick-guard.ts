// K-20 / OPS-010: every periodic tick (schedules, webhooks, worker claims) runs through guardTick. A failing tick
// (e.g. the database is down) is caught and logged instead of becoming an unhandled rejection that exits the process,
// and consecutive failures back off exponentially (1s, 2s, 4s, ... capped at 30s) so an outage does not flood the log
// (OPS-004). A success resets the backoff. No global unhandledRejection handler is installed on purpose.
// Pure module: no imports, injectable clock and logger, so it is unit-testable without a database.

export const TICK_BACKOFF_MIN_MS = 1_000;
export const TICK_BACKOFF_MAX_MS = 30_000;

/** Backoff after `consecutiveFailures` failures in a row: min * 2^(n-1), capped at max. 0 failures -> 0. */
export function tickBackoffMs(consecutiveFailures: number, minMs = TICK_BACKOFF_MIN_MS, maxMs = TICK_BACKOFF_MAX_MS): number {
  if (consecutiveFailures <= 0) return 0;
  const exponent = Math.min(consecutiveFailures - 1, 30);
  return Math.min(maxMs, minMs * 2 ** exponent);
}

/** Short, log-safe description of an error: name/code/message only (no stack, no object dump, no config). */
export function describeTickError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const message = error.message.length > 300 ? `${error.message.slice(0, 300)}…` : error.message;
    return `${error.name}${typeof code === "string" && code ? ` ${code}` : ""}: ${message}`;
  }
  return typeof error === "string" ? error.slice(0, 300) : "non-error value thrown";
}

export interface TickGuardOptions {
  now?: () => number;
  log?: (message: string) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface TickGuardState {
  consecutiveFailures: number;
  /** Epoch ms before which ticks are skipped (0 = no backoff). */
  nextAllowedAt: number;
  running: boolean;
}

export interface GuardedTick {
  /** Runs the tick unless one is still running or the backoff has not elapsed. Never rejects. */
  run(): Promise<"ran" | "failed" | "skipped">;
  state(): TickGuardState;
}

export function guardTick(name: string, tick: () => Promise<unknown>, options: TickGuardOptions = {}): GuardedTick {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.error(message));
  const minMs = options.minBackoffMs ?? TICK_BACKOFF_MIN_MS;
  const maxMs = options.maxBackoffMs ?? TICK_BACKOFF_MAX_MS;
  const state: TickGuardState = { consecutiveFailures: 0, nextAllowedAt: 0, running: false };

  return {
    async run() {
      if (state.running || now() < state.nextAllowedAt) return "skipped";
      state.running = true;
      try {
        await tick();
        if (state.consecutiveFailures > 0) log(`[tick:${name}] recovered after ${state.consecutiveFailures} consecutive failure(s)`);
        state.consecutiveFailures = 0;
        state.nextAllowedAt = 0;
        return "ran";
      } catch (error) {
        state.consecutiveFailures += 1;
        const delay = tickBackoffMs(state.consecutiveFailures, minMs, maxMs);
        state.nextAllowedAt = now() + delay;
        log(`[tick:${name}] failed (${state.consecutiveFailures} in a row), next attempt in ${delay}ms: ${describeTickError(error)}`);
        return "failed";
      } finally {
        state.running = false;
      }
    },
    state: () => ({ ...state }),
  };
}
