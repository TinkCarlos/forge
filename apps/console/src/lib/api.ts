import { reportNetworkError, reportUnavailable } from "./api-availability";

/** K-35：断网（fetch 抛 TypeError）的固定错误码。 */
export const NETWORK_ERROR_CODE = "NET-0001";

export type Session = { csrfToken?: string; user?: { name?: string; email?: string; role?: string } } & Record<string, unknown>;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

let session: Session | null = null;
let onUnauthorized: () => void = () => {};

export function setSession(next: Session | null) {
  session = next;
}
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && session?.csrfToken) headers["x-csrf-token"] = session.csrfToken;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (err) {
    // 主动取消不是断网，原样抛出；其余（Failed to fetch 等）统一成中文提示 + 固定码，不再显示浏览器英文原文。
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    reportNetworkError();
    throw new ApiError("网络连接失败", 0, NETWORK_ERROR_CODE);
  }
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (response.status === 401 && !path.startsWith("/auth/local/login")) onUnauthorized();
  if (response.status === 503) reportUnavailable(payload?.error?.code);
  if (!response.ok) {
    throw new ApiError(payload?.error?.message ?? `请求失败（${response.status}）`, response.status, payload?.error?.code);
  }
  return payload as T;
}
