import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  assertOutboundAllowed,
  assertOutboundUrlStatic,
  createPinnedLookup,
  isBlockedAddress,
  OUTBOUND_BLOCKED_CODE,
  OUTBOUND_BLOCKED_MESSAGE,
  parseOutboundAllowlist,
  safeFetch,
  setOutboundResolver,
} from "@forge/core";

// S-46 ~ S-49: one outbound guard for every server-side HTTP request. No public network: DNS is mocked through
// setOutboundResolver and the only real sockets go to a local 127.0.0.1 server that is explicitly allowlisted.
type Answer = Array<{ address: string; family: 4 | 6 }>;
const dns = new Map<string, Answer>();
let lookups: string[] = [];
const fakeResolver = async (host: string): Promise<Answer> => {
  lookups.push(host);
  const answer = dns.get(host);
  if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return answer;
};
const v4 = (address: string): Answer => [{ address, family: 4 }];
const v6 = (address: string): Answer => [{ address, family: 6 }];

let server: Server;
let port = 0;
let allow: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: url.searchParams.get("to") ?? "/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`ok ${req.method} ${url.pathname}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  allow = parseOutboundAllowlist(`127.0.0.1:${port}`);
});
afterAll(async () => {
  setOutboundResolver(null);
  await new Promise((resolve) => server.close(resolve));
});
afterEach(() => {
  dns.clear();
  lookups = [];
  setOutboundResolver(fakeResolver);
});
setOutboundResolver(fakeResolver);

const blocked = async (promise: Promise<unknown>) => {
  const error = (await promise.then(() => null, (e: unknown) => e)) as { code?: string; httpStatus?: number; message?: string } | null;
  expect(error, "expected the request to be blocked").not.toBeNull();
  expect(error!.code).toBe(OUTBOUND_BLOCKED_CODE);
  expect(error!.httpStatus).toBe(400);
  expect(error!.message).toBe(OUTBOUND_BLOCKED_MESSAGE);
  return error!;
};

describe("isBlockedAddress: every reserved range", () => {
  const bad = [
    "127.0.0.1", "127.255.255.254", "::1",
    "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "fc00::1", "fd00::1", "fdff:ffff::1",
    "169.254.169.254", "169.254.0.1", "fe80::1", "febf::1",
    "0.0.0.0", "0.1.2.3", "100.64.0.1", "100.127.255.255",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:8.8.8.8", "::ffff:7f00:1",
    "::", "64:ff9b::a00:1", "ff02::1", "224.0.0.1", "255.255.255.255", "240.0.0.1", "198.18.0.1",
  ];
  const good = ["8.8.8.8", "93.184.215.14", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "2606:4700:4700::1111", "11.0.0.1"];
  for (const address of bad) it(`blocks ${address}`, () => expect(isBlockedAddress(address)).toBe(true));
  for (const address of good) it(`allows ${address}`, () => expect(isBlockedAddress(address)).toBe(false));
});

describe("assertOutboundAllowed: literals and encodings (S-48)", () => {
  const literals = [
    "http://127.0.0.1/", "http://127.1/", "http://localhost:8080/", "http://LOCALHOST/", "http://foo.localhost/", "http://printer.local/",
    "http://[::1]/", "http://[0:0:0:0:0:0:0:1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/",
    "http://169.254.169.254/latest/meta-data/", "http://[fd00::1]/", "http://[fd12:3456::1]:8443/", "http://[fe80::1]/",
    "http://2130706433/", "http://017700000001/", "http://0177.0.0.1/", "http://0x7f000001/", "http://0x7f.0x0.0x0.0x1/",
    "http://2852039166/", "http://0251.0376.0251.0376/", "http://0xa9fea9fe/", "http://0/", "http://0.0.0.0:80/", "http://100.64.1.1/",
    "http://10.1.2.3/", "http://172.20.0.1/", "http://192.168.0.10/", "https://0xA9.254.169.254/",
  ];
  for (const url of literals) {
    it(`blocks ${url}`, async () => {
      await blocked(assertOutboundAllowed(url, { allowlist: [] }));
      expect(() => assertOutboundUrlStatic(url, { allowlist: [] })).toThrow(OUTBOUND_BLOCKED_MESSAGE);
    });
  }
  for (const url of ["file:///etc/passwd", "ftp://example.com/", "gopher://127.0.0.1:6379/_x", "data:text/plain,hi", "javascript:alert(1)"]) {
    it(`blocks non-http scheme ${url.split(":")[0]}`, async () => {
      await blocked(assertOutboundAllowed(url, { allowlist: [] }));
      expect(() => assertOutboundUrlStatic(url, { allowlist: [] })).toThrow(OUTBOUND_BLOCKED_MESSAGE);
    });
  }
  it("error does not echo the resolved private IP", async () => {
    dns.set("evil.example", v4("10.20.30.40"));
    const error = await blocked(assertOutboundAllowed("http://evil.example/", { allowlist: [] }));
    expect(JSON.stringify({ message: error.message, details: (error as { details?: unknown }).details })).not.toContain("10.20.30.40");
  });
});

describe("assertOutboundAllowed: DNS answers (mocked)", () => {
  it("public answer passes and is returned for pinning", async () => {
    dns.set("api.example", [{ address: "93.184.215.14", family: 4 }, { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 }]);
    const target = await assertOutboundAllowed("https://api.example/v1", { allowlist: [] });
    expect(target.addresses.map((a) => a.address)).toEqual(["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]);
  });
  for (const [name, answer] of [
    ["metadata", v4("169.254.169.254")], ["loopback v6", v6("::1")], ["ULA fd00::/8", v6("fd00::abcd")], ["private v4", v4("192.168.10.1")],
    ["CGNAT", v4("100.100.100.100")], ["mapped", v6("::ffff:10.0.0.1")], ["link-local v6", v6("fe80::1")], ["0.0.0.0/8", v4("0.0.0.7")],
  ] as const) {
    it(`hostname resolving to ${name} is blocked`, async () => {
      dns.set("internal.example", answer as Answer);
      await blocked(assertOutboundAllowed("http://internal.example/", { allowlist: [] }));
    });
  }
  it("blocked if ANY answer is private (mixed public + private)", async () => {
    dns.set("mixed.example", [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await blocked(assertOutboundAllowed("http://mixed.example/", { allowlist: [] }));
  });
  it("static check does not resolve DNS (only literals and localhost-style names)", () => {
    dns.set("internal.example", v4("10.0.0.1"));
    expect(() => assertOutboundUrlStatic("http://internal.example/", { allowlist: [] })).not.toThrow();
    expect(lookups).toHaveLength(0);
  });
});

describe("OUTBOUND_ALLOWLIST (host:port)", () => {
  it("parses entries and rejects malformed ones", () => {
    expect(parseOutboundAllowlist(" 127.0.0.1:8090, LocalHost:8090 ,[::1]:9000,")).toEqual(["127.0.0.1:8090", "localhost:8090", "[::1]:9000"]);
    expect(parseOutboundAllowlist("")).toEqual([]);
    expect(() => parseOutboundAllowlist("127.0.0.1")).toThrow();
    expect(() => parseOutboundAllowlist("http://127.0.0.1:8090")).toThrow();
  });
  it("only the exact host:port is allowed (default ports included)", async () => {
    const list = parseOutboundAllowlist("127.0.0.1:8090,localhost:80,[::1]:9000");
    await expect(assertOutboundAllowed("http://127.0.0.1:8090/mcp", { allowlist: list })).resolves.toBeTruthy();
    await expect(assertOutboundAllowed("http://localhost/", { allowlist: list })).resolves.toBeTruthy();
    await expect(assertOutboundAllowed("http://[::1]:9000/", { allowlist: list })).resolves.toBeTruthy();
    expect(() => assertOutboundUrlStatic("http://127.0.0.1:8090/x", { allowlist: list })).not.toThrow();
    await blocked(assertOutboundAllowed("http://127.0.0.1:8091/", { allowlist: list }));
    await blocked(assertOutboundAllowed("https://localhost/", { allowlist: list }));
    // entries match the normalized URL host: an encoded IP in the allowlist does not open 127.0.0.1
    await blocked(assertOutboundAllowed("http://2130706433:8090/", { allowlist: parseOutboundAllowlist("2130706433:8090") }));
  });
  it("allowlist never enables non-http schemes", async () => {
    await blocked(assertOutboundAllowed("file://127.0.0.1:8090/etc/passwd", { allowlist: parseOutboundAllowlist("127.0.0.1:8090") }));
  });
});

describe("safeFetch: pinned connection, redirects (S-48 / S-49)", () => {
  it("fetches an allowlisted local target", async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/hello`, { allowlist: allow });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok GET /hello");
  });
  it("same target without the allowlist is blocked before any socket is opened", async () => {
    await blocked(safeFetch(`http://127.0.0.1:${port}/hello`, { allowlist: [] }));
  });
  it("302 redirect to a private address is blocked (169.254.169.254, 10/8 via DNS, [::1], decimal IP)", async () => {
    dns.set("internal.example", v4("10.0.0.8"));
    for (const to of ["http://169.254.169.254/latest/meta-data/", "http://internal.example/", "http://[::1]/", "http://2130706433/", "http://0251.0376.0251.0376/"]) {
      await blocked(safeFetch(`http://127.0.0.1:${port}/redirect?to=${encodeURIComponent(to)}`, { allowlist: allow }));
    }
  });
  it("302 to file:// is blocked", async () => {
    await blocked(safeFetch(`http://127.0.0.1:${port}/redirect?to=${encodeURIComponent("file:///etc/passwd")}`, { allowlist: allow }));
  });
  it("redirects inside the allowlist are followed (each hop re-validated), with a hop limit", async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/redirect?to=/final`, { allowlist: allow });
    expect(await res.text()).toBe("ok GET /final");
    const loop = `http://127.0.0.1:${port}/redirect?to=${encodeURIComponent(`/redirect?to=${encodeURIComponent("/redirect?to=/redirect")}`)}`;
    await expect(safeFetch(loop, { allowlist: allow, maxRedirects: 2 })).rejects.toThrow();
  });
  it("redirect: 'manual' returns the 3xx response untouched", async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/redirect?to=${encodeURIComponent("http://169.254.169.254/")}`, { allowlist: allow, redirect: "manual" });
    expect(res.status).toBe(302);
  });
  it("DNS rebinding: the hostname is resolved once per hop and the socket only uses the validated answer", async () => {
    let calls = 0;
    setOutboundResolver(async (host) => {
      calls += 1;
      // first answer: a non-routable documentation address (passes the guard, never reaches the internet);
      // any second lookup would answer loopback.
      return calls === 1 ? v4("192.0.2.1") : v4("127.0.0.1");
    });
    const error = await safeFetch(`http://rebind.example:${port}/`, { signal: AbortSignal.timeout(300) }).then(() => null, (e: unknown) => e);
    expect(error).not.toBeNull();
    expect(calls).toBe(1);
  });
  it("createPinnedLookup answers only with the pinned addresses (both lookup callback shapes)", async () => {
    const lookup = createPinnedLookup([{ address: "93.184.215.14", family: 4 }, { address: "2606:4700::1", family: 6 }]);
    const all = await new Promise((resolve) => lookup("whatever.example", { all: true }, (_e: unknown, a: unknown) => resolve(a)));
    expect(all).toEqual([{ address: "93.184.215.14", family: 4 }, { address: "2606:4700::1", family: 6 }]);
    const one = await new Promise((resolve) => lookup("whatever.example", {}, (_e: unknown, a: unknown, f: unknown) => resolve([a, f])));
    expect(one).toEqual(["93.184.215.14", 4]);
    const only6 = await new Promise((resolve) => lookup("whatever.example", { family: 6 }, (_e: unknown, a: unknown, f: unknown) => resolve([a, f])));
    expect(only6).toEqual(["2606:4700::1", 6]);
  });
  it("POST body and headers are sent; response streams like fetch", async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/post`, { allowlist: allow, method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("text/plain");
    const reader = res.body!.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe("ok POST /post");
  });
});
