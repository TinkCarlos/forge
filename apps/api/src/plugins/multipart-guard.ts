import { type FastifyInstance } from "fastify";
import { ForgeError } from "@forge/core";
import { isAdminApiRequest, isAuthRequest } from "./csrf.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Item 8: this admin route reads a multipart/form-data upload. Every other admin write route answers 415. */
    multipartUpload?: boolean;
  }
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Item 8: @fastify/multipart is registered app-wide, so a multipart body reached admin write handlers as an empty body
 * (defaults applied, sometimes 200). Mutating /admin/api requests with a multipart Content-Type are refused with
 * 415 OPN-4505 before the handler (and before CSRF / auth) unless the route declares `config.multipartUpload`.
 * Item B: the same for /auth write routes (login, logout). /open and /integration are not covered.
 */
export function installAdminMultipartGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    if (!WRITE_METHODS.has(request.method) || !(isAdminApiRequest(request) || isAuthRequest(request))) return;
    const type = String(request.headers["content-type"] ?? "").trim().toLowerCase();
    if (!type.startsWith("multipart/")) return;
    if (request.routeOptions?.config?.multipartUpload === true) return;
    throw new ForgeError("OPN-4505", { message: "不支持的 Content-Type", httpStatus: 415, retryable: false });
  });
}
