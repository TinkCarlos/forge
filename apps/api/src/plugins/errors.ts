import { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ERROR_CODES, ForgeError, type ErrorCode } from "@forge/core";
import type { ApiErrorResponse } from "@forge/contracts";
import { maskArgsDeep, maskProseSecrets } from "@forge/governance";
import { logSafeError } from "@forge/runtime";
import { reqId } from "./http-helpers.js";
import { auditRequestFailure } from "./failure-audit.js";

// Installed directly on the root instance (not via register) so every route context inherits it.
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (error, request, reply) => {
    const parse = bodyParseError(error);
    await auditRequestFailure(request, error instanceof ForgeError ? error.code : parse?.code ?? (isDuplicateKey(error) ? "CFG-8503" : "SYS-9001"), error instanceof ForgeError ? error.httpStatus : parse?.status ?? (isDuplicateKey(error) ? 409 : 500));
    if (error instanceof ForgeError) return sendError(error, request, reply);
    if (parse) return sendError(new ForgeError(parse.code, { message: parse.message, httpStatus: parse.status }), request, reply);
    if (isDuplicateKey(error)) {
      request.log.warn({ dbCode: "ER_DUP_ENTRY" }, "unique key conflict -> 409");
      return sendError(new ForgeError("CFG-8503", { message: "资源已存在（唯一字段重复）" }), request, reply, false);
    }
    request.log.error({ err: logSafeError(error) }, "unhandled error");
    return sendError(new ForgeError("SYS-9001", {}, error), request, reply, false);
  });
}

function sendError(error: ForgeError, request: FastifyRequest, reply: FastifyReply, log = true): void {
  if (log) {
    const fields = { code: error.code, err: logSafeError(error) };
    if (error.httpStatus >= 500) request.log.error(fields, "request failed");
    else request.log.warn(fields, "request rejected");
  }
  if (error.headers) reply.headers(error.headers);
  const body: ApiErrorResponse = { error: {
    code: error.code,
    message: error.httpStatus >= 500 || error.code === "SYS-9001" ? ERROR_CODES[error.code].userMessage : maskProseSecrets(error.message),
    requestId: reqId(request),
    details: error.httpStatus >= 500 ? null : maskArgsDeep(error.details ?? null),
    retryable: error.retryable,
    remedy: error.remedy,
  } };
  reply.status(error.httpStatus).send(body);
}

/**
 * Fastify `frameworkErrors` (P2-01 / K26-BADURL): errors raised before routing, chiefly FST_ERR_BAD_URL for a path that
 * cannot be percent-decoded. Fastify's default body echoes the raw path; this answers with the unified error body and
 * nothing of the URL, path or query. A path parameter over maxParamLength (FST_ERR_MAX_PARAM_LENGTH) names an id that
 * cannot exist: 404 RUN-7001 like any unknown id (was 500). Anything else raised there is a server error (no details).
 */
export function frameworkErrorHandler(error: { code?: string }, request: FastifyRequest, reply: FastifyReply): void {
  if (error.code === "FST_ERR_BAD_URL") return sendError(new ForgeError("CFG-8501", { message: "请求地址无法解析" }), request, reply);
  if (error.code === "FST_ERR_MAX_PARAM_LENGTH") return sendError(new ForgeError("RUN-7001"), request, reply);
  request.log.error({ code: error.code }, "framework error");
  sendError(new ForgeError("SYS-9001", {}, error), request, reply, false);
}

/** Maps Fastify content-type parser / body errors to 413 OPN-4504, 415 OPN-4505 or 400 CFG-8501. */
function bodyParseError(error: unknown): { status: number; code: ErrorCode; message: string } | null {
  const e = error as { code?: string; statusCode?: number; name?: string };
  switch (e.code) {
    case "FST_ERR_CTP_BODY_TOO_LARGE":
    case "FST_REQ_FILE_TOO_LARGE":
    case "FST_PARTS_LIMIT":
    case "FST_FILES_LIMIT":
    case "FST_FIELDS_LIMIT":
      return { status: 413, code: "OPN-4504", message: "请求体过大" };
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
    case "FST_INVALID_MULTIPART_CONTENT_TYPE":
      return { status: 415, code: "OPN-4505", message: "不支持的 Content-Type" };
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
      return { status: 400, code: "CFG-8501", message: "请求体为空，但 Content-Type 声明为 JSON" };
    case "FST_ERR_CTP_INVALID_JSON_BODY":
    case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
    case "FST_ERR_CTP_INVALID_TYPE":
      return { status: 400, code: "CFG-8501", message: "请求体不是合法的 JSON" };
    default:
      break;
  }
  // Older Fastify JSON parser: a SyntaxError carrying statusCode 400.
  if (e.name === "SyntaxError" && e.statusCode === 400) return { status: 400, code: "CFG-8501", message: "请求体不是合法的 JSON" };
  return null;
}

/** mysql2 duplicate-key error (ER_DUP_ENTRY / errno 1062), also when wrapped once in `cause`. */
export function isDuplicateKey(error: unknown): boolean {
  for (let e = error as { code?: unknown; errno?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 3; e = e.cause as typeof e, depth++) {
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true;
  }
  return false;
}
