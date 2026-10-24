import { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ForgeError } from "@forge/core";
import { reqId } from "./http-helpers.js";

// Installed directly on the root instance (not via register) so every route context inherits it.
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ForgeError) {
      reply.status(error.httpStatus).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: reqId(request),
          details: error.details ?? null,
          retryable: error.retryable,
        },
      });
      return;
    }
    // Body parsing failures are client errors (K-09 / I-CSRF-06), not 500. Parsing still runs before the CSRF preHandler.
    const parse = bodyParseError(error);
    if (parse) {
      reply.status(parse.status).send({
        error: { code: parse.code, message: parse.message, requestId: reqId(request), details: null, retryable: false },
      });
      return;
    }
    // P1-10 / S-25: a unique-key collision is a client conflict. The driver error (code, index, value, SQL) goes
    // to the log only; the response says nothing about tables, indexes or values.
    if (isDuplicateKey(error)) {
      request.log.warn({ err: error, dbCode: "ER_DUP_ENTRY" }, "unique key conflict -> 409");
      reply.status(409).send({
        error: { code: "CFG-8503", message: "资源已存在（唯一字段重复）", requestId: reqId(request), details: null, retryable: false },
      });
      return;
    }
    request.log.error(error);
    reply.status(500).send({
      error: { code: "SYS-9001", message: "内部错误", requestId: reqId(request), retryable: false },
    });
  });
}

/**
 * Fastify `frameworkErrors` (P2-01 / K26-BADURL): errors raised before routing, chiefly FST_ERR_BAD_URL for a path that
 * cannot be percent-decoded. Fastify's default body echoes the raw path; this answers with the unified error body and
 * nothing of the URL, path or query. A path parameter over maxParamLength (FST_ERR_MAX_PARAM_LENGTH) names an id that
 * cannot exist: 404 RUN-7001 like any unknown id (was 500). Anything else raised there is a server error (no details).
 */
export function frameworkErrorHandler(error: { code?: string }, request: FastifyRequest, reply: FastifyReply): void {
  if (error.code === "FST_ERR_BAD_URL") {
    reply.status(400).send({ error: { code: "CFG-8501", message: "请求地址无法解析", requestId: reqId(request), details: null, retryable: false } });
    return;
  }
  if (error.code === "FST_ERR_MAX_PARAM_LENGTH") {
    reply.status(404).send({ error: { code: "RUN-7001", message: "资源不存在", requestId: reqId(request), details: null, retryable: false } });
    return;
  }
  request.log.error({ code: error.code }, "framework error");
  reply.status(500).send({ error: { code: "SYS-9001", message: "内部错误", requestId: reqId(request), retryable: false } });
}

/** Maps Fastify content-type parser / body errors to 413 OPN-4504, 415 OPN-4505 or 400 CFG-8501. */
function bodyParseError(error: unknown): { status: number; code: string; message: string } | null {
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
