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
    request.log.error(error);
    reply.status(500).send({
      error: { code: "SYS-9001", message: "内部错误", requestId: reqId(request), retryable: false },
    });
  });
}
