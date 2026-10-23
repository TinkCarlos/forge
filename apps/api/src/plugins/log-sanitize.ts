import type { FastifyInstance } from "fastify";

// K-26 / OPS-014: request URLs are logged as path + query, with the value of any sensitive query key replaced by
// [REDACTED]. Done in the request serializer (and the 404 handler, which logs the URL itself) rather than via pino
// `redact` paths, because the secret is inside the url string, not a separate field.
// Pure module: no @forge/* imports, so it is unit-testable without config, .env or a database.

export const REDACTED = "[REDACTED]";

/** Query keys (case-insensitive, after percent-decoding, ignoring a trailing [] / [x]) whose values are never logged. */
export const SENSITIVE_QUERY_KEYS: ReadonlySet<string> = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "key",
  "secret",
  "client_secret",
  "password",
  "code",
  "state",
]);

const MAX_LOGGED_URL_LENGTH = 2048;

function decodeKey(raw: string): string {
  let value = raw.replace(/\+/g, " ");
  // Up to 3 rounds so double-encoded keys (%2574oken) are recognised too; stop at the first malformed escape.
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(value);
    } catch {
      break;
    }
    if (next === value) break;
    value = next;
  }
  return value.trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
}

export function isSensitiveQueryKey(rawKey: string): boolean {
  return SENSITIVE_QUERY_KEYS.has(decodeKey(rawKey));
}

/**
 * Path + query with sensitive values redacted. Never throws: non-strings become "", malformed escapes are kept
 * as-is (only keys are decoded, for matching), repeated keys are all redacted, the fragment is dropped and the
 * result is capped at 2048 characters.
 */
export function sanitizeUrlForLog(url: unknown): string {
  if (typeof url !== "string") return "";
  const withoutFragment = url.split("#", 1)[0] ?? "";
  const q = withoutFragment.indexOf("?");
  let result: string;
  if (q === -1) {
    result = withoutFragment;
  } else {
    const path = withoutFragment.slice(0, q);
    const query = withoutFragment.slice(q + 1);
    const parts = query.split("&").map((part) => {
      const eq = part.indexOf("=");
      const rawKey = eq === -1 ? part : part.slice(0, eq);
      if (!isSensitiveQueryKey(rawKey)) return part;
      return `${rawKey}=${REDACTED}`;
    });
    result = `${path}?${parts.join("&")}`;
  }
  return result.length > MAX_LOGGED_URL_LENGTH ? `${result.slice(0, MAX_LOGGED_URL_LENGTH)}…[truncated]` : result;
}

interface LoggableRequest {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number } | null;
}

/** Same shape as Fastify's default `req` serializer, with `url` sanitized. */
export function serializeRequestForLog(req: LoggableRequest): {
  method: string | undefined;
  url: string;
  version: string | undefined;
  host: string | undefined;
  remoteAddress: string | undefined;
  remotePort: number | undefined;
} {
  const version = req.headers?.["accept-version"];
  return {
    method: req.method,
    url: sanitizeUrlForLog(req.url),
    version: typeof version === "string" ? version : undefined,
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  };
}

/** Serializers to pass to Fastify's logger options. */
export const requestLogSerializers = { req: serializeRequestForLog };

/**
 * Replaces Fastify's default 404 handler, which logs and echoes the raw URL (`Route GET:/x?token=... not found`).
 * Same response shape and status; the URL in both the log line and the message is sanitized.
 */
export function installSanitizedNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const message = `Route ${request.method}:${sanitizeUrlForLog(request.raw.url ?? request.url)} not found`;
    request.log.info(message);
    reply.code(404).send({ message, error: "Not Found", statusCode: 404 });
  });
}
