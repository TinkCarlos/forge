import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import { ForgeError } from "@forge/core";
import { nextPhaseSeq } from "../phase-seq.js";

// r4 shutdown: SSE streams (streamRun) are hijacked responses that only end when the run ends, so app.close() used to
// wait for them until the 10 s shutdown backstop fired (exit 1). Every stream is registered here; on close:
//  1. preClose (first step of app.close()): draining starts. /readyz answers not_ready, a new SSE request on an
//     already-open keep-alive connection gets 503 SYS-9003 + Retry-After: 1, any other request the 503 Fastify gave
//     before (return503OnClosing is off so these answers can be ours).
//  2. Still inside preClose, before its done(): server.close() closes the listening socket (synchronously), then the
//     streams are ended, so an EventSource reconnect gets ECONNREFUSED and keeps retrying with Last-Event-ID (a
//     non-200 answer would close it for good). Nothing is sent before the end: no completed or shutdown event, the
//     response is just finished. Fastify 5.12.7 calls server.close() again right after the preClose hooks
//     (fastify.js:385-418); on a closed server that callback runs on 'close' (all connections gone) and Fastify takes
//     its ERR_SERVER_NOT_RUNNING as success, so app.close() still waits for the connections. Everything in this step
//     is logged before done(), so it is logged before app.close() resolves and before shutdown.ts logs exit.
//  3. Idle keep-alive sockets left by the ended streams are closed so server.close() can complete; every response
//     sent while draining carries Connection: close. In-flight requests finish, then the process exits 0.
// Connections that are open but have not sent a single byte yet (browser preconnect, a proxy's spare upstream
// connection) are closed in step 2 as well. Who closes them depends on the Node version: on Node 22 and 24
// closeIdleConnections() (called by server.close() and by Fastify's forceCloseConnections: 'idle') does not count
// them as idle, so server.close() waited for them until the 10 s backstop fired (exit 1) even with no SSE stream open
// (IDLE-02) and step 2 closes them; from Node 26.4 (nodejs/node#63470) closeIdleConnections() destroys them itself,
// inside server.close(). Step 2 takes their snapshot before server.close() and counts those that are closed after it,
// by Node or by us, so listener_closed reports the same count on every version (r6 A20).

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

export function installSseShutdown(app: FastifyInstance): void {
  const registry: SseRegistry = { draining: false, streams: new Map() };
  app.decorate("forgeSse", registry);

  const sockets = new Set<Socket>();
  app.server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  /** Connections that have not sent a byte yet and are still open. */
  const unusedConnections = (): Socket[] => [...sockets].filter((socket) => socket.bytesRead === 0 && !socket.destroyed);
  /**
   * Step 2, after server.close(): closes connections that never sent a byte (no request started, nothing to answer)
   * and returns how many of `before` (taken before server.close()) are closed now, whoever closed them (Node >= 26.4
   * already did inside server.close()). A connection that had sent a byte before is not counted; one accepted after
   * the snapshot is closed but not counted.
   * Known limit (QA on ced7f76, 5/5): a connection that sent only part of its request headers and then stalls has
   * bytesRead > 0, so it is not closed here, and Node does not count it as idle either. server.close() waits for it
   * until the 10 s backstop in shutdown.ts fires and the process exits 1. Normal clients (browsers, proxies) send the
   * whole header block at once, so this does not happen with them; it is left as is on purpose.
   */
  const closeUnusedConnections = (before: Socket[]): number => {
    for (const socket of unusedConnections()) socket.destroy();
    return before.filter((socket) => socket.destroyed).length;
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

  // r4: one info line per shutdown step, ms since preClose (the first thing app.close() does after the signal).
  // Not the same zero as shutdown.ts: its phases (signal, app_close, stop_runtime, pool_end, exit) count ms from
  // the signal, these (readyz_not_ready, ..., on_close) from preClose, so the two ms series are not comparable as-is.
  // phaseSeq (one counter with shutdown.ts, see phase-seq.ts) gives the order across both.
  let closeStartedAt = 0;
  const step = (phase: string, extra: Record<string, unknown> = {}): void =>
    app.log.info({ phase, phaseSeq: nextPhaseSeq(), ms: Date.now() - closeStartedAt, ...extra }, `shutdown: ${phase}`);

  app.addHook("onClose", (_instance, done) => {
    step("on_close");
    done();
  });

  app.addHook("preClose", function (done) {
    closeStartedAt = Date.now();
    registry.draining = true;
    step("readyz_not_ready");
    const server = app.server;
    // Step 2, run to the end before done(). close() without a callback: Fastify's own server.close(cb) waits for the
    // connections. http.Server.close() also closes the idle keep-alive connections.
    const unusedBeforeClose = unusedConnections();
    if (server.listening) server.close();
    const unusedConnectionsClosed = closeUnusedConnections(unusedBeforeClose);
    step("listener_closed", { listening: server.listening, unusedConnectionsClosed, count: unusedConnectionsClosed });
    const streams = [...registry.streams];
    const ended = (): void => {
      step("sse_ended", { streams: streams.length, count: streams.length });
      done();
    };
    if (streams.length === 0) {
      ended();
      return;
    }
    // Wait until every ended response has finished (its last chunk handed to the socket) or its connection closed,
    // so sse_ended and done() come after it and nothing of this step is still pending when shutdown.ts logs exit. A
    // client that stops reading holds this, as it held server.close() before; the shutdown backstop covers both.
    let pending = streams.length;
    const oneEnded = (): void => {
      pending -= 1;
      if (pending === 0) ended();
    };
    for (const [raw, end] of streams) {
      registry.streams.delete(raw);
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        oneEnded();
      };
      raw.once("finish", () => {
        server.closeIdleConnections?.();
        settle();
      });
      raw.once("close", settle);
      end();
    }
  });
}
