import { ERROR_CODES, isErrorCode, type ErrorCode } from "./codes.js";

export interface ForgeErrorContext {
  message?: string;
  details?: unknown;
  httpStatus?: number;
  retryable?: boolean;
  headers?: Readonly<Record<string, string>>;
}

export class ForgeError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;
  readonly retryable: boolean;
  readonly remedy: string;
  readonly headers?: Readonly<Record<string, string>>;

  constructor(code: ErrorCode, context: ForgeErrorContext = {}, cause?: unknown) {
    const registered = isErrorCode(code);
    const status = context.httpStatus ?? (registered ? ERROR_CODES[code].httpStatus : 500);
    const known = registered && Number.isInteger(status) && status >= 400 && status <= 599;
    const definition = ERROR_CODES[known ? code : "SYS-9001"];
    super(known ? context.message ?? definition.userMessage : definition.userMessage, { cause });
    this.name = "ForgeError";
    this.code = definition.code;
    this.httpStatus = known ? context.httpStatus ?? definition.httpStatus : definition.httpStatus;
    this.retryable = known ? context.retryable ?? definition.retryable : definition.retryable;
    this.details = known ? context.details : undefined;
    this.headers = known ? context.headers : undefined;
    this.remedy = definition.remedy;
  }
}
