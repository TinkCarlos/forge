import { ERROR_CODES, type ErrorCode } from "../../core/src/errors/codes.js";

export interface ApiErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details: unknown;
    retryable: boolean;
    remedy: string;
  };
}

export const API_ERROR_RESPONSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["error"],
  properties: { error: {
    type: "object", additionalProperties: false,
    required: ["code", "message", "requestId", "details", "retryable", "remedy"],
    properties: {
      code: { type: "string", enum: Object.keys(ERROR_CODES) }, message: { type: "string" }, requestId: { type: "string" },
      details: {}, retryable: { type: "boolean" }, remedy: { type: "string" },
    },
  } },
} as const;
