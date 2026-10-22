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
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (response.status === 401 && !path.startsWith("/auth/local/login")) onUnauthorized();
  if (!response.ok) {
    throw new ApiError(payload?.error?.message ?? `请求失败（${response.status}）`, response.status, payload?.error?.code);
  }
  return payload as T;
}
