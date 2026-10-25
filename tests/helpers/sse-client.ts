import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect, createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// Shutdown tests (SIG-xx): a real API child process and a raw SSE client. Ports reserved by other local services
// are never used.
const RESERVED = (port: number): boolean =>
  port === 3100 || (port >= 3191 && port <= 3199) || port === 4176 || (port >= 4178 && port <= 4180) || (port >= 8090 && port <= 8094) || port === 3307;
export const isReservedPort = RESERVED;
const HELPERS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HELPERS, "..", "..");

export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const value = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(value));
      });
    });
    if (port > 0 && !RESERVED(port)) return port;
  }
}

export interface ApiProcess {
  port: number;
  child: ChildProcess;
  /** Resolves with the exit code once the child exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
  output: () => string;
  /** stdout / stderr of the child separately (output() is both, in arrival order). */
  stdout: () => string;
  stderr: () => string;
}

/** Test-only preloads in tests/helpers (node --import); nothing in apps/ can turn them on. */
export type TestPreload = "slow-threadpool" | "stuck-flush" | "pending-pool-end";
const PRELOAD_FILES: Record<TestPreload, string> = {
  "slow-threadpool": "preload-slow-threadpool.mjs",
  "stuck-flush": "preload-stuck-flush.mjs",
  "pending-pool-end": "preload-pending-pool-end.mjs",
};

/** Written to stderr by preload-signal-ready.mjs once the child's SIGTERM handler is installed. */
export const SIGNAL_READY = "[test-preload] SIGTERM handler installed";

export interface TestOnlyStartOptions {
  /** slow-threadpool also sets UV_THREADPOOL_SIZE=1 for the child. */
  preload?: TestPreload[];
  /** NODE_ENV of the child; default "test" ("unset" removes it). */
  nodeEnv?: "development" | "test" | "unset";
}

/**
 * Starts apps/api/src/server.ts (tsx) on a free 127.0.0.1 port, embedded worker off, same test DB and secrets.
 * `extraEnv` can only raise the log level (LOG_LEVEL). `testOnly` is for the shutdown log tests only: test preloads
 * from tests/helpers (slow libuv thread pool, a logger flush that never calls back) and the child's NODE_ENV.
 * NODE_ENV is pinned to "test" for the child unless `testOnly.nodeEnv` says otherwise: under "development" app.ts logs
 * through pino-pretty, and the tests that read the child's log as JSON (SIG-09) parse JSON lines only.
 */
export async function startApiProcess(extraEnv: { LOG_LEVEL?: "info" } = {}, testOnly: TestOnlyStartOptions = {}): Promise<ApiProcess> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", PORT: String(port), HOST: "127.0.0.1", EMBEDDED_WORKER: "false", LOG_LEVEL: "warn", ...extraEnv };
  if (testOnly.nodeEnv === "unset") delete env.NODE_ENV;
  else if (testOnly.nodeEnv) env.NODE_ENV = testOnly.nodeEnv;
  const preloads = testOnly.preload ?? [];
  if (preloads.includes("slow-threadpool")) env.UV_THREADPOOL_SIZE = "1";
  // Every child: preload-signal-ready.mjs reports on stderr once server.ts has installed its SIGTERM handler.
  const preloadArgs = ["preload-signal-ready.mjs", ...preloads.map((name) => PRELOAD_FILES[name])].flatMap((file) => ["--import", pathToFileURL(join(HELPERS, file)).href]);
  const child = spawn(process.execPath, ["--import", "tsx", ...preloadArgs, "apps/api/src/server.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    out += text;
    stdout += text;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    out += text;
    stderr += text;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })),
  );
  const started = Date.now();
  // Not just "Forge API listening": server.ts installs its signal handlers right after printing it, and a signal sent
  // in between kills the child (seen once in SIG-10c, exit code null).
  while (!(out.includes("Forge API listening") && stderr.includes(SIGNAL_READY))) {
    if (child.exitCode !== null) throw new Error(`API process exited during startup: ${out.slice(-800)}`);
    if (Date.now() - started > 30_000) {
      child.kill("SIGKILL");
      throw new Error(`API process did not start in 30 s: ${out.slice(-800)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { port, child, exited, output: () => out, stdout: () => stdout, stderr: () => stderr };
}

export interface SseEvent {
  id: number;
  type: string;
}

export interface SseStream {
  response: IncomingMessage;
  events: SseEvent[];
  raw: () => string;
  /** "end": the response finished normally (terminal chunk); "aborted": the connection broke mid-response. */
  finished: Promise<"end" | "aborted">;
  waitFor: (count: number, timeoutMs?: number) => Promise<void>;
}

/** Opens a GET SSE request on its own TCP connection; resolves once the 200 headers arrived. */
export function openSse(port: number, path: string, headers: Record<string, string>): Promise<SseStream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { accept: "text/event-stream", ...headers }, agent: false }, (response) => {
      if (response.statusCode !== 200) {
        let body = "";
        response.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        response.on("end", () => reject(new Error(`SSE status ${response.statusCode}: ${body.slice(0, 300)}`)));
        return;
      }
      let text = "";
      const events: SseEvent[] = [];
      let buffer = "";
      let waiters: Array<() => void> = [];
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const id = /^id: (\d+)$/m.exec(block);
          const type = /^event: (.+)$/m.exec(block);
          if (id && type) events.push({ id: Number(id[1]), type: type[1]! });
        }
        for (const waiter of waiters) waiter();
      });
      const finished = new Promise<"end" | "aborted">((done) => {
        let settled = false;
        const settle = (value: "end" | "aborted") => {
          if (!settled) {
            settled = true;
            done(value);
          }
        };
        response.once("end", () => settle(response.complete ? "end" : "aborted"));
        response.once("aborted", () => settle("aborted"));
        response.once("error", () => settle("aborted"));
        response.once("close", () => settle(response.complete ? "end" : "aborted"));
      });
      const waitFor = (count: number, timeoutMs = 5000) =>
        new Promise<void>((ok, fail) => {
          const timer = setTimeout(() => fail(new Error(`waited for ${count} events, got ${events.length}: ${text.slice(-300)}`)), timeoutMs);
          const check = () => {
            if (events.length >= count) {
              clearTimeout(timer);
              waiters = waiters.filter((w) => w !== check);
              ok();
            }
          };
          waiters.push(check);
          check();
        });
      resolve({ response, events, raw: () => text, finished, waitFor });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Opens a new TCP connection; resolves "refused" on ECONNREFUSED, otherwise the first status line it receives. */
export function probeNewConnection(port: number, path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let data = "";
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED" ? "refused" : `error ${error.code}`));
    socket.once("connect", () => {
      const lines = [`GET ${path} HTTP/1.1`, "Host: 127.0.0.1", "Accept: text/event-stream", "Connection: close", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      const line = data.split("\r\n")[0];
      if (line && data.includes("\r\n")) {
        resolve(line);
        socket.destroy();
      }
    });
    socket.once("close", () => resolve(data ? data.split("\r\n")[0]! : "closed without response"));
  });
}

/**
 * Opens a keep-alive connection and sends only the request line and Host header, so the server has started parsing
 * a request on it (Node does not count it as idle and server.close() leaves it open). `finish()` sends the remaining
 * headers and resolves with everything the server wrote until it closed the connection: the "request on an already
 * open keep-alive connection during shutdown" case.
 */
export async function partialRequest(port: number, path: string, headers: Record<string, string>): Promise<{ finish: () => Promise<string> }> {
  const socket = connect({ host: "127.0.0.1", port });
  let data = "";
  socket.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
  socket.on("error", () => undefined);
  const closed = new Promise<string>((resolve) => socket.once("close", () => resolve(data)));
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    finish: async () => {
      const rest = ["Connection: keep-alive", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)].join("\r\n");
      socket.write(`${rest}\r\n\r\n`);
      return closed;
    },
  };
}

export interface RawConnection {
  /** Everything the server sent on this connection so far. */
  data: () => string;
  write: (text: string) => void;
  /** Resolves with everything received once the server (or the client) closed the connection. */
  closed: Promise<string>;
  /** Resolves once the first complete response head and its Content-Length body arrived. */
  response: (fromOffset?: number) => Promise<string>;
}

/** A plain TCP connection to the API, like a browser or a proxy keeps open between requests. */
export async function rawConnection(port: number): Promise<RawConnection> {
  const socket = connect({ host: "127.0.0.1", port });
  let data = "";
  socket.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
  socket.on("error", () => undefined);
  const closed = new Promise<string>((resolve) => socket.once("close", () => resolve(data)));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const response = async (fromOffset = 0): Promise<string> => {
    for (;;) {
      const text = data.slice(fromOffset);
      const headEnd = text.indexOf("\r\n\r\n");
      if (headEnd >= 0) {
        const length = Number(/content-length:\s*(\d+)/i.exec(text.slice(0, headEnd))?.[1] ?? 0);
        if (text.length >= headEnd + 4 + length) return text.slice(0, headEnd + 4 + length);
      }
      if (socket.destroyed) throw new Error(`connection closed before a full response: ${JSON.stringify(text.slice(0, 200))}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { data: () => data, write: (text) => void socket.write(text), closed, response };
}

/** A keep-alive GET request as a browser or proxy sends it. */
export const keepAliveGet = (path: string, headers: Record<string, string> = {}): string =>
  [`GET ${path} HTTP/1.1`, "Host: 127.0.0.1", "Connection: keep-alive", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)].join("\r\n") + "\r\n\r\n";
