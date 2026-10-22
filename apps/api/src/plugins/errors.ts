import { type FastifyInstance } from "fastify";
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
    request.log.error(error);
    reply.status(500).send({
      error: { code: "SYS-9001", message: "内部错误", requestId: reqId(request), retryable: false },
    });
  });
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
