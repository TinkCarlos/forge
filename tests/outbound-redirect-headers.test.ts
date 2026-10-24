import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch } from "@forge/core";

// P2-04c: on a cross-origin redirect hop safeFetch forwards only safe headers (accept, accept-language, user-agent,
// accept-encoding, content-type when a body is still sent); Authorization, Cookie, Proxy-Authorization and every
// caller-specific header (x-api-key, ...) are dropped. Same-origin hops keep them. Origin = scheme + host + port.
// Two local servers on 127.0.0.1 (different ports = different origins), both allowlisted.
const seen: Array<{ server: string; path: string; method: string; headers: IncomingHttpHeaders; body: string }> = [];
let a: Server;
let b: Server;
let pa = 0;
let pb = 0;
function make(name: string): Server {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      seen.push({ server: name, path: url.pathname, method: req.method ?? "", headers: req.headers, body });
      if (url.pathname === "/redirect") {
        res.writeHead(Number(url.searchParams.get("status") ?? 302), { location: url.searchParams.get("to") ?? "/" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
}
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
const allow = () => [`127.0.0.1:${pa}`, `127.0.0.1:${pb}`];
const secretHeaders = {
  authorization: "Bearer t-1",
  cookie: "sid=c-1",
  "proxy-authorization": "Basic p-1",
  "x-api-key": "k-1",
  "x-custom-trace": "trace-1",
  accept: "application/json",
  "accept-language": "zh-CN",
  "user-agent": "forge-test",
};

beforeAll(async () => {
  a = make("a");
  b = make("b");
  pa = await listen(a);
  pb = await listen(b);
});
afterAll(async () => {
  await new Promise((r) => a.close(r));
  await new Promise((r) => b.close(r));
});

async function follow(to: string, init: { method?: string; body?: string; status?: number; extra?: Record<string, string> } = {}) {
  seen.length = 0;
  const res = await safeFetch(`http://127.0.0.1:${pa}/redirect?status=${init.status ?? 302}&to=${encodeURIComponent(to)}`, {
    allowlist: allow(),
    method: init.method,
    body: init.body,
    headers: { ...secretHeaders, ...(init.extra ?? {}) },
  });
  expect(res.status).toBe(200);
  await res.text();
  return seen.at(-1)!;
}
const DROPPED = ["authorization", "cookie", "proxy-authorization", "x-api-key", "x-custom-trace"];

describe("P2-04c safeFetch: cross-origin redirects strip credentials and custom headers", () => {
  it("cross-origin (other port) 302: only safe headers reach the new origin", async () => {
    const last = await follow(`http://127.0.0.1:${pb}/final`);
    expect(last.server).toBe("b");
    for (const h of DROPPED) expect(last.headers[h], h).toBeUndefined();
    expect(last.headers).toMatchObject({ accept: "application/json", "accept-language": "zh-CN", "user-agent": "forge-test" });
  });

  it("same-origin 302: custom headers and credentials are kept", async () => {
    const last = await follow("/final");
    expect(last.server).toBe("a");
    expect(last.headers).toMatchObject({ authorization: "Bearer t-1", cookie: "sid=c-1", "x-api-key": "k-1", "x-custom-trace": "trace-1" });
  });

  it("once stripped, a later hop back to the first origin does not get them back", async () => {
    const back = `http://127.0.0.1:${pa}/final`;
    const last = await follow(`http://127.0.0.1:${pb}/redirect?to=${encodeURIComponent(back)}`);
    expect(last.server).toBe("a");
    for (const h of DROPPED) expect(last.headers[h], h).toBeUndefined();
  });

  it("307 cross-origin keeps method and body but still drops credentials (content-type kept)", async () => {
    const last = await follow(`http://127.0.0.1:${pb}/final`, { method: "POST", body: "{\"a\":1}", status: 307, extra: { "content-type": "application/json" } });
    expect(last).toMatchObject({ server: "b", method: "POST", body: "{\"a\":1}" });
    expect(last.headers["content-type"]).toBe("application/json");
    for (const h of DROPPED) expect(last.headers[h], h).toBeUndefined();
  });

  it("303 turns into GET without body", async () => {
    const last = await follow(`http://127.0.0.1:${pb}/final`, { method: "POST", body: "x=1", status: 303 });
    expect(last).toMatchObject({ server: "b", method: "GET", body: "" });
  });
});
