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

const REDACTED = "[REDACTED]";
/** Same sensitive query keys as the K-26 request-log sanitizer (apps/api/src/plugins/log-sanitize.ts), plus pwd/passwd
 * and presigned-URL signatures (P2, QA 714b3f3). Only inside a URL query or fragment (`?&;#` before the key). */
const SENSITIVE_QUERY_KEY =
  "token|access_token|refresh_token|id_token|api_key|apikey|key|secret|client_secret|password|passwd|pwd|code|state|sig|signature|" +
  "x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential";
/** Bare `key=value` anywhere in the text (no `?`): only unambiguous credential keys, so `code=ER_...` stays readable. */
const BARE_KEY = "access_token|refresh_token|id_token|client_secret|api_key|apikey|token|secret|password|passwd|pwd|authorization";
/** JSON / object-literal keys whose string value is a credential (segment match, case-insensitive). */
const JSON_KEY = "[^\"]*(?:password|passwd|pwd|secret|token|api_?key|authorization|cookie|credential|signature)[^\"]*";
// Userinfo runs to the LAST `@` before the path / whitespace, so an unencoded `@` inside the password is covered.
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi;
const BARE_USERINFO = /(^|[\s(=,'"[])[^\s:@/()'"[\]]+:[^\s/]+@(?=[^\s@/]+)/g;
const JSON_SECRET = new RegExp(`("${JSON_KEY}"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*"`, "gi");
// Scheme names are matched case-sensitively (Bearer/bearer/BEARER, Basic) so prose like "basic check" stays readable.
const AUTH_SCHEME = /\b(Bearer|bearer|BEARER|Basic)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+/g;
const AUTH_HEADER = /\b(authorization\s*[:=]\s*)(?!(?:Bearer|bearer|BEARER|Basic)\s)(?!\[REDACTED\])[^\s,;&"']+/gi;
const SENSITIVE_QUERY = new RegExp(`([?&;#](?:${SENSITIVE_QUERY_KEY})(?:\\[[^\\]]*\\])?=)[^&\\s#]*`, "gi");
const BARE_SECRET = new RegExp(`((?:^|[^\\w?&;#.-])(?:${BARE_KEY})=)(?!\\[REDACTED\\])[^&\\s#,;'")]*`, "gi");

/**
 * P2-05: credentials inside an error message (driver errors quote connection strings) are redacted before the message
 * is logged: `scheme://user:pass@` and bare `user:pass@host` userinfo -> `[REDACTED]@`, sensitive query / fragment
 * values -> `[REDACTED]`. P2 (QA 714b3f3) adds: an unencoded `@` in the password, JSON `"password":"..."`-style keys,
 * `Bearer|Basic <value>` and `Authorization: <value>`, bare `password=...` outside a query string,
 * `#access_token=` fragments and presigned-URL signatures. Runs before truncation so a secret straddling the cut cannot
 * survive half-masked.
 */
export function redactCredentials(message: string): string {
  return message
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(BARE_USERINFO, `$1${REDACTED}@`)
    .replace(JSON_SECRET, `$1${REDACTED}"`)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(AUTH_HEADER, `$1${REDACTED}`)
    .replace(SENSITIVE_QUERY, `$1${REDACTED}`)
    .replace(BARE_SECRET, `$1${REDACTED}`);
}

const truncate = (text: string): string => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

/** Short, log-safe description of an error: name/code/message only (no stack, no object dump, no config, no credentials). */
export function describeTickError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}${typeof code === "string" && code ? ` ${code}` : ""}: ${truncate(redactCredentials(error.message))}`;
  }
  return typeof error === "string" ? redactCredentials(error).slice(0, 300) : "non-error value thrown";
}

/**
 * P2 (QA 714b3f3): what a log call may carry instead of a raw error object (whose own properties can hold a driver
 * config, SQL with values or a request with headers): type, string code, and the redacted message and stack.
 */
export function logSafeError(error: unknown): { type: string; code?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      type: error.name,
      ...(typeof code === "string" && code ? { code } : {}),
      message: truncate(redactCredentials(error.message)),
      ...(error.stack ? { stack: redactCredentials(error.stack).slice(0, 4_000) } : {}),
    };
  }
  return typeof error === "string" ? { type: "string", message: redactCredentials(error).slice(0, 300) } : { type: typeof error, message: "non-error value thrown" };
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
