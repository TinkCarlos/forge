import { type FastifyInstance } from "fastify";

// P1-06 / S-10: security headers on every response (no new dependency; @fastify/helmet is not installed).
// Set on reply.raw in onRequest so they also reach hijacked responses (SSE streamRun writes its own writeHead,
// and Node merges headers set earlier with setHeader), 404s, body-parse 400s and static files.

const BASE_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

/** Policy for everything except the legacy console page: no unsafe-inline, no unsafe-eval. */
export const CONTENT_SECURITY_POLICY = BASE_DIRECTIVES.join("; ");

/**
 * Legacy console (`GET /`, apps/console/public): its markup uses inline onclick= / style= attributes, so only
 * attribute-level inline is allowed there (script-src-attr / style-src-attr); <script> blocks and eval stay blocked.
 * TEMPORARY EXCEPTION (S-10), approved in writing by the architect (P1-06 ⑤), recorded in
 * docs/02-architecture/permissions.md 4.5: only `/` and `/index.html` get it; script-src stays 'self' (no
 * unsafe-inline), and /next/, /api/*, /admin/api/*, /auth/* and static assets are never relaxed
 * (pinned by tests/security-headers.test.ts). Remove once the legacy console is retired or drops inline attributes.
 */
export const LEGACY_CONSOLE_CSP = [...BASE_DIRECTIVES, "script-src-attr 'unsafe-inline'", "style-src-attr 'unsafe-inline'"].join("; ");

export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

function isLegacyConsole(url: string): boolean {
  const pathOnly = url.split("?")[0] ?? "";
  return pathOnly === "/" || pathOnly === "/index.html";
}

export function installSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) reply.raw.setHeader(name, value);
    reply.raw.setHeader("Content-Security-Policy", isLegacyConsole(request.url) ? LEGACY_CONSOLE_CSP : CONTENT_SECURITY_POLICY);
  });
}
