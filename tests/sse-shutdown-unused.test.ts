import { once } from "node:events";
import type { Server } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { installSseShutdown } from "../apps/api/src/plugins/sse-shutdown.js";

// r6 A20: listener_closed {unusedConnectionsClosed, count} must be the connections that had not sent a byte when the
// close started and are closed by the end of the step, whoever closed them. Node >= 26.4 (nodejs/node#63470) destroys
// such connections inside server.close() (closeIdleConnections), Node 22/24 leave them open; the count must not depend
// on that. The in-process app is the plugin alone on a bare Fastify, logging to an array.

interface Harness {
  app: FastifyInstance;
  server: Server;
  port: number;
  lines: Array<Record<string, unknown>>;
  /** Server-side sockets in accept order. */
  accepted: Socket[];
  clients: Socket[];
}

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) {
    for (const c of h.clients) c.destroy();
    await h.app.close().catch(() => undefined);
  }
});

async function harness(): Promise<Harness> {
  const lines: Array<Record<string, unknown>> = [];
  const app = Fastify({
    logger: { level: "info", stream: { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) } },
    return503OnClosing: false,
  });
  installSseShutdown(app);
  app.get("/ping", async () => ({ ok: true }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const accepted: Socket[] = [];
  app.server.on("connection", (socket: Socket) => accepted.push(socket));
  const h: Harness = { app, server: app.server, port: (app.server.address() as AddressInfo).port, lines, accepted, clients: [] };
  open.push(h);
  return h;
}

/** A client connection that never sends a byte; resolves once the server has accepted it. */
async function unusedConnection(h: Harness): Promise<Socket> {
  const acceptedNow = once(h.server, "connection");
  const client = net.connect(h.port, "127.0.0.1");
  client.on("error", () => undefined);
  h.clients.push(client);
  const [serverSide] = (await acceptedNow) as [Socket];
  return serverSide;
}

/** A keep-alive connection that has sent one request and read its whole answer (idle, bytesRead > 0). */
async function usedConnection(h: Harness): Promise<Socket> {
  const acceptedNow = once(h.server, "connection");
  const client = net.connect(h.port, "127.0.0.1");
  client.on("error", () => undefined);
  h.clients.push(client);
  const [serverSide] = (await acceptedNow) as [Socket];
  let got = "";
  const answered = new Promise<void>((resolve) => {
    client.on("data", (chunk: Buffer) => {
      got += chunk.toString("latin1");
      if (got.includes("\r\n\r\n") && got.endsWith("}")) resolve();
    });
  });
  client.write("GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  await answered;
  expect(serverSide.bytesRead, "the used connection has sent its request").toBeGreaterThan(0);
  return serverSide;
}

/** What Node >= 26.4 does (nodejs/node#63470): closeIdleConnections() also destroys connections that sent no byte. */
function behaveLikeNode26(server: Server, accepted: Socket[]): void {
  const original = server.closeIdleConnections.bind(server);
  server.closeIdleConnections = () => {
    for (const socket of accepted) if (socket.bytesRead === 0 && !socket.destroyed) socket.destroy();
    original();
  };
}

function listenerClosed(h: Harness): Record<string, unknown> {
  const found = h.lines.filter((line) => line.phase === "listener_closed");
  expect(found, JSON.stringify(h.lines)).toHaveLength(1);
  return found[0]!;
}

describe("A20: listener_closed counts the never-used connections closed in the step, on any Node version", () => {
  it("as this Node version closes them: one never-used connection -> count 1, closed", async () => {
    const h = await harness();
    const unused = await unusedConnection(h);
    await h.app.close();
    expect(listenerClosed(h), JSON.stringify(h.lines)).toMatchObject({ unusedConnectionsClosed: 1, count: 1 });
    expect(unused.destroyed).toBe(true);
  });

  it("Node >= 26.4 (simulated): server.close() destroys the never-used connection itself -> still count 1", async () => {
    const h = await harness();
    const unused = await unusedConnection(h);
    behaveLikeNode26(h.server, h.accepted);
    await h.app.close();
    expect(listenerClosed(h), JSON.stringify(h.lines)).toMatchObject({ unusedConnectionsClosed: 1, count: 1 });
    expect(unused.destroyed).toBe(true);
  });

  it("a connection that had sent a request before the close is not counted, also when Node closes it (simulated >= 26.4)", async () => {
    const h = await harness();
    const used = await usedConnection(h);
    const unused = await unusedConnection(h);
    behaveLikeNode26(h.server, h.accepted);
    await h.app.close();
    expect(listenerClosed(h), JSON.stringify(h.lines)).toMatchObject({ unusedConnectionsClosed: 1, count: 1 });
    expect(used.destroyed).toBe(true);
    expect(unused.destroyed).toBe(true);
  });

  it("a connection accepted after the snapshot (inside server.close()) is not counted, and is still closed", async () => {
    const h = await harness();
    const unused = await unusedConnection(h);
    // A second listener hands over a connection that has sent nothing, as if accepted while the close runs.
    const side = net.createServer();
    side.listen(0, "127.0.0.1");
    await once(side, "listening");
    const late = net.connect((side.address() as AddressInfo).port, "127.0.0.1");
    late.on("error", () => undefined);
    h.clients.push(late);
    const [lateServerSide] = (await once(side, "connection")) as [Socket];
    side.close();
    const original = h.server.closeIdleConnections.bind(h.server);
    h.server.closeIdleConnections = () => {
      h.server.emit("connection", lateServerSide);
      original();
    };
    await h.app.close();
    expect(listenerClosed(h), JSON.stringify(h.lines)).toMatchObject({ unusedConnectionsClosed: 1, count: 1 });
    expect(unused.destroyed).toBe(true);
    expect(lateServerSide.destroyed).toBe(true);
  });
});
