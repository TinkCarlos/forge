import { type FastifyInstance, type FastifyRequest } from "fastify";
import { errors } from "@forge/core";
import { readStoredSession } from "./http-helpers.js";

const ADMIN_API_PREFIX = "/admin/api";
const AUTH_PREFIX = "/auth/";

/** Percent-decoded path of the raw URL (no query). Undecodable input is kept raw: it cannot match a route anyway. */
function decodedPath(rawUrl: string): string {
  const path = rawUrl.split("?")[0] ?? "";
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * AF (S-60): the router matches the decoded path, so `/%61dmin/api/...` reaches /admin/api handlers while
 * `request.url` keeps the raw encoding. Decide on the matched route template (and, as a backstop, the decoded path),
 * never on the raw URL prefix.
 */
/** Item B: a request for an /auth route (matched template, or the decoded path as a backstop, like isAdminApiRequest). */
export function isAuthRequest(request: Pick<FastifyRequest, "url" | "routeOptions">): boolean {
  const route = request.routeOptions?.url ?? "";
  return route.startsWith(AUTH_PREFIX) || decodedPath(request.url).startsWith(AUTH_PREFIX);
}

export function isAdminApiRequest(request: Pick<FastifyRequest, "url" | "routeOptions">): boolean {
  const route = request.routeOptions?.url ?? "";
  return route.startsWith(ADMIN_API_PREFIX) || decodedPath(request.url).startsWith(ADMIN_API_PREFIX);
}

// Root-level preHandler: enforces X-CSRF-Token on mutating /admin/api requests that carry a session.
export function installCsrfHook(app: FastifyInstance): void {
  app.addHook("preHandler", async (request) => {
    if (isAdminApiRequest(request) && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const session = await readStoredSession(request);
      if (session && request.headers["x-csrf-token"] !== session.csrfToken) {
        throw errors.forbidden("CSRF Token 缺失或无效");
      }
    }
  });
}
