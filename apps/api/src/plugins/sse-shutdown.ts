import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import { ForgeError } from "@forge/core";

// r4 shutdown: SSE streams (streamRun) are hijacked responses that only end when the run ends, so app.close() used to
// wait for them until the 10 s shutdown backstop fired (exit 1). Every stream is registered here; on close:
//  1. preClose (first step of app.close()): draining starts. /readyz answers not_ready, a new SSE request on an
//     already-open keep-alive connection gets 503 SYS-9003 + Retry-After: 1, any other request the 503 Fastify gave
//     before (return503OnClosing is off so these answers can be ours).
//  2. Fastify 5.12.7 calls server.close() right after the preClose hooks (fastify.js:385-418), which closes the
//     listening socket synchronously. Only then are the streams ended, so an EventSource reconnect gets ECONNREFUSED
//     and keeps retrying with Last-Event-ID (a non-200 answer would close it for good). Nothing is sent before the
//     end: no completed or shutdown event, the response is just finished.
//  3. Idle keep-alive sockets left by the ended streams are closed so server.close() can complete; every response
//     sent while draining carries Connection: close. In-flight requests finish, then the process exits 0.
// Connections that are open but have not sent a single byte yet (browser preconnect, a proxy's spare upstream
// connection) are closed in step 2 as well: Node 22's closeIdleConnections() (called by Fastify's
// forceCloseConnections: 'idle' and by server.close()) does not count them as idle, so server.close() waited for them
// until the 10 s backstop fired (exit 1) even with no SSE stream open (IDLE-02).

declare module "fastify" {
  interface FastifyInstance {
    /** r4 shutdown: open SSE streams and the draining flag (shared by every encapsulated child instance). */
    forgeSse: SseRegistry;
  }
  interface FastifyContextConfig {
    /** r4 shutdown: this route answers with an SSE stream (streamRun). */
    sse?: boolean;
  }
}

export interface SseRegistry {
  draining: boolean;
  streams: Map<ServerResponse, () => void>;
}

/** 503 SYS-9003 with Retry-After: 1 for an SSE request that arrives while the API is shutting down. */
export function sseShuttingDown(): ForgeError {
  return new ForgeError("SYS-9003", "服务正在停机，请稍后重试", 503, undefined, true, { "Retry-After": "1" });
}

// `app` can be undefined: streamRun is also called with a bare request (unit tests, no Fastify instance). Without
// the registry there is no shutdown to take part in, so nothing is registered.
export function isDraining(app: FastifyInstance | undefined): boolean {
  return app?.forgeSse?.draining === true;
}

/** Registers an open stream; `end` stops its polling and finishes the response. Returns the unregister function. */
export function registerSseStream(app: FastifyInstance | undefined, raw: ServerResponse, end: () => void): () => void {
  const registry = app?.forgeSse;
  if (!registry) return () => undefined;
  registry.streams.set(raw, end);
  return () => {
    registry.streams.delete(raw);
  };
}

/** Max setImmediate turns to wait for Fastify's server.close() before the streams are ended anyway. */
const LISTEN_CLOSE_WAIT_TURNS = 200;

export function installSseShutdown(app: FastifyInstance): void {
  const registry: SseRegistry = { draining: false, streams: new Map() };
  app.decorate("forgeSse", registry);

  const sockets = new Set<Socket>();
  app.server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  /** Step 2: closes connections that never sent a byte (no request started, nothing to answer). */
  const closeUnusedConnections = (): number => {
    let closed = 0;
    for (const socket of sockets) {
      if (socket.bytesRead === 0 && !socket.destroyed) {
        socket.destroy();
        closed += 1;
      }
    }
    return closed;
  };

  app.addHook("onRequest", async (request, reply) => {
    if (!registry.draining) return;
    if (request.routeOptions?.config?.sse === true) throw sseShuttingDown();
    if (request.routeOptions?.url === "/readyz") return; // health route answers not_ready itself
    // Same answer Fastify's return503OnClosing gave before (lib/route.js, 5.12.7).
    reply.raw.setHeader("Connection", "close");
    return reply.code(503).type("application/json").send({ error: "Service Unavailable", message: "Service Unavailable", statusCode: 503 });
  });

  // Every response sent while draining carries Connection: close (also requests that started before the close).
  app.addHook("onSend", async (_request, reply, payload) => {
    if (registry.draining) reply.header("Connection", "close");
    return payload;
  });

  app.addHook("preClose", function (done) {
    registry.draining = true;
    done();
    const server = app.server;
    let turns = 0;
    const endStreams = (): void => {
      if (server.listening && turns < LISTEN_CLOSE_WAIT_TURNS) {
        turns += 1;
        setImmediate(endStreams);
        return;
      }
      closeUnusedConnections();
      for (const [raw, end] of [...registry.streams]) {
        registry.streams.delete(raw);
        raw.once("finish", () => setImmediate(() => server.closeIdleConnections?.()));
        end();
      }
    };
    setImmediate(endStreams);
  });
}
