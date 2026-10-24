import http from "node:http";
import https from "node:https";
import { lookup as systemLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { allowlistProblems } from "./allowlist-format";
import { config } from "./config";
import { ForgeError } from "./index";

/**
 * Outbound request guard (S-46 ~ S-49). Every server-side HTTP request (MCP, model providers, OpenAPI tools, web_fetch,
 * webhooks, OIDC) goes through assertOutboundAllowed / safeFetch:
 * - only http/https;
 * - the host is resolved once and EVERY answer is checked against the reserved ranges below (encoded IPv4 such as
 *   2130706433 / 0177.0.0.1 / 0x7f000001 is normalized by the WHATWG URL parser before the check);
 * - the socket is pinned to the answers that were checked (custom `lookup`), so a second DNS answer (rebinding) is never used;
 * - redirects are followed manually, re-validating every hop (or not followed with redirect: "manual");
 * - OUTBOUND_ALLOWLIST (comma separated host:port) opts specific targets out of the address check (e.g. a local mock).
 * Blocked -> 400 HTP-4003「目标地址不允许（内网/回环/元数据）」, never echoing the resolved address to the client;
 * the server log (setOutboundLogger) records host, port, resolved addresses and a reason (AD).
 */
export const OUTBOUND_BLOCKED_CODE = "HTP-4003";
export const OUTBOUND_BLOCKED_MESSAGE = "目标地址不允许（内网/回环/元数据）";
const MAX_REDIRECTS = 5;

export function outboundBlockedError(): ForgeError {
  return new ForgeError(OUTBOUND_BLOCKED_CODE, OUTBOUND_BLOCKED_MESSAGE, 400, undefined, false);
}

/** Why a target was refused (server log only). "redirect" = a redirect hop was refused; see targetReason. */
export type OutboundBlockReason =
  | "scheme" | "invalid_url" | "local_hostname" | "loopback" | "private" | "metadata" | "link_local" | "cgnat"
  | "unspecified" | "ipv4_mapped" | "ipv4_embedded" | "multicast" | "reserved" | "invalid_address" | "redirect";

export interface OutboundBlockLog {
  event: "outbound.blocked";
  code: typeof OUTBOUND_BLOCKED_CODE;
  reason: OutboundBlockReason;
  /** Only for reason "redirect": why the redirect target was refused. */
  targetReason?: OutboundBlockReason;
  /** 0 = the requested URL, n = the n-th redirect hop. */
  hop: number;
  protocol: string;
  host: string;
  port: string;
  /** Resolved / literal addresses that were checked (never sent to the client). */
  addresses: string[];
}
type OutboundLogger = (entry: OutboundBlockLog) => void;
const defaultLogger: OutboundLogger = (entry) => console.warn(JSON.stringify({ level: "warn", msg: "outbound request blocked", ...entry }));
let outboundLogger: OutboundLogger = defaultLogger;

/** Where blocked outbound requests are logged (server side only). null restores the default (JSON line on stderr). */
export function setOutboundLogger(next: OutboundLogger | null): void {
  outboundLogger = next ?? defaultLogger;
}

// Separate lists: a BlockList checks IPv4 addresses against IPv6 rules through ::ffff:0:0/96, which would match everything.
const blockList4 = new BlockList();
const blockList6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1 (documentation)
  ["198.51.100.0", 24], // TEST-NET-2 (documentation)
  ["203.0.113.0", 24], // TEST-NET-3 (documentation)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) blockList4.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::", 96], // IPv4-compatible (deprecated)
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2002::", 16], // 6to4 (embeds an IPv4 address): refused as a whole range, like NAT64
  // Teredo 2001:0::/32 is checked by its embedded server / client IPv4 (teredoEmbeddedIpv4), not as a range.
  ["fc00::", 7], // unique local (fd00::/8 included)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) blockList6.addSubnet(net, prefix, "ipv6");

// Classification for the log (the block decision itself uses blockList4/6 above).
const reasonLists: Array<[OutboundBlockReason, BlockList]> = [];
function reasonList(reason: OutboundBlockReason, nets: Array<[string, number, "ipv4" | "ipv6"]>): void {
  const list = new BlockList();
  for (const [net, prefix, type] of nets) {
    if (prefix === 32 || prefix === 128) list.addAddress(net, type);
    else list.addSubnet(net, prefix, type);
  }
  reasonLists.push([reason, list]);
}
reasonList("metadata", [["169.254.169.254", 32, "ipv4"], ["169.254.170.2", 32, "ipv4"], ["fd00:ec2::254", 128, "ipv6"]]);
reasonList("loopback", [["127.0.0.0", 8, "ipv4"], ["::1", 128, "ipv6"]]);
reasonList("unspecified", [["0.0.0.0", 8, "ipv4"], ["::", 128, "ipv6"]]);
reasonList("ipv4_mapped", [["::ffff:0:0", 96, "ipv6"]]);
reasonList("ipv4_embedded", [["::", 96, "ipv6"], ["64:ff9b::", 96, "ipv6"], ["64:ff9b:1::", 48, "ipv6"], ["2002::", 16, "ipv6"]]);
reasonList("private", [["10.0.0.0", 8, "ipv4"], ["172.16.0.0", 12, "ipv4"], ["192.168.0.0", 16, "ipv4"], ["fc00::", 7, "ipv6"], ["fec0::", 10, "ipv6"]]);
reasonList("link_local", [["169.254.0.0", 16, "ipv4"], ["fe80::", 10, "ipv6"]]);
reasonList("cgnat", [["100.64.0.0", 10, "ipv4"]]);
reasonList("multicast", [["224.0.0.0", 4, "ipv4"], ["ff00::", 8, "ipv6"]]);

/** The 8 16-bit words of an IPv6 address (accepts "::" and a dotted IPv4 tail), or null when it does not parse. */
function ipv6Words(address: string): number[] | null {
  let text = address;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return null;
    const o = dotted[1]!.split(".").map(Number);
    tail.push((o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!);
    text = text.slice(0, -dotted[1]!.length);
    if (!text.endsWith("::")) text = text.replace(/:$/, "");
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const part = (h: string | undefined) => (h ? h.split(":").filter((x) => x !== "").map((x) => parseInt(x, 16)) : []);
  const head = part(halves[0]);
  const rest = part(halves[1]);
  const words = halves.length === 2 ? [...head, ...new Array(8 - tail.length - head.length - rest.length).fill(0), ...rest, ...tail] : [...head, ...tail];
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

const v4FromWords = (hi: number, lo: number): string => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");

/**
 * P2-04a: Teredo (2001:0::/32) embeds the server IPv4 (words 2-3) and the client IPv4 XOR 0xffffffff (words 6-7).
 * Both are checked against the IPv4 rules. (6to4 2002::/16 and NAT64 64:ff9b::/96 are refused as whole ranges.)
 */
function teredoEmbeddedIpv4(address: string): string[] {
  const w = ipv6Words(address);
  if (!w || w[0] !== 0x2001 || w[1] !== 0) return [];
  return [v4FromWords(w[2]!, w[3]!), v4FromWords(w[6]! ^ 0xffff, w[7]! ^ 0xffff)];
}
const teredoBlocked = (address: string): boolean => teredoEmbeddedIpv4(address).some((v4) => blockList4.check(v4, "ipv4"));

/** Log reason for a blocked address (first matching category; anything else blocked is "reserved"). */
export function classifyBlockedAddress(address: string): OutboundBlockReason {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  const family = isIP(bare);
  if (!family) return "invalid_address";
  const type = family === 4 ? "ipv4" : "ipv6";
  if (type === "ipv6" && teredoBlocked(bare)) return "ipv4_embedded";
  for (const [reason, list] of reasonLists) {
    // An IPv4 address must not be matched against IPv6-only rules (see the note on blockList4/6).
    if (list.check(bare, type)) {
      if (type === "ipv4" && (reason === "ipv4_mapped" || reason === "ipv4_embedded")) continue;
      return reason;
    }
  }
  return "reserved";
}

/** True for loopback, private, link-local/metadata, CGNAT, 0/8, IPv4-mapped/compatible IPv6, multicast and other reserved addresses. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  const family = isIP(bare);
  if (family === 4) return blockList4.check(bare, "ipv4");
  if (family === 6) return blockList6.check(bare, "ipv6") || teredoBlocked(bare);
  return true; // not an IP at all: refuse rather than guess
}

const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "metadata", "metadata.google.internal"]);
function isLocalHostname(host: string): boolean {
  return LOCAL_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local");
}

/** Parses OUTBOUND_ALLOWLIST ("host:port,host:port", IPv6 as [addr]:port). Throws on a malformed entry. */
export function parseOutboundAllowlist(raw: string | undefined | null): string[] {
  const entries: string[] = [];
  // Exact host:port only (AD). Invalid entries already fail config loading at startup; same per-entry messages here.
  const problems = allowlistProblems(raw);
  if (problems.length) throw new Error(problems.join("\n"));
  for (const part of String(raw ?? "").split(",")) {
    const entry = part.trim().toLowerCase();
    if (entry) entries.push(entry);
  }
  return entries;
}

export type OutboundAddress = { address: string; family: 4 | 6 };
type Resolver = (host: string) => Promise<OutboundAddress[]>;
const defaultResolver: Resolver = async (host) =>
  (await systemLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
let resolver: Resolver = defaultResolver;

/** Test hook: replace DNS resolution (pass null to restore the system resolver). */
export function setOutboundResolver(next: Resolver | null): void {
  resolver = next ?? defaultResolver;
}

export interface OutboundOptions {
  /** Overrides config.OUTBOUND_ALLOWLIST (already parsed). */
  allowlist?: string[];
}

function configuredAllowlist(): string[] {
  return parseOutboundAllowlist((config as { OUTBOUND_ALLOWLIST?: string }).OUTBOUND_ALLOWLIST);
}

type Target = { url: URL; host: string; hostKey: string; port: string; allowlisted: (list: string[]) => boolean };

/** Logs the refusal (host, port, addresses, reason) and returns the client-facing error, which carries no address. */
function refuse(target: { protocol: string; host: string; port: string }, reason: OutboundBlockReason, addresses: string[], hop: number): ForgeError {
  const entry: OutboundBlockLog = { event: "outbound.blocked", code: OUTBOUND_BLOCKED_CODE, reason: hop > 0 ? "redirect" : reason, hop, protocol: target.protocol, host: target.host, port: target.port, addresses };
  if (hop > 0) entry.targetReason = reason;
  try {
    outboundLogger(entry);
  } catch {
    // logging must never change the decision
  }
  return outboundBlockedError();
}

function parseTarget(raw: string | URL, hop = 0): Target {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw refuse({ protocol: "", host: "", port: "" }, "invalid_url", [], hop);
  }
  const hostKey = url.hostname.toLowerCase(); // keeps [..] for IPv6
  const host = hostKey.replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw refuse({ protocol: url.protocol, host, port }, "scheme", [], hop);
  return { url, host, hostKey, port, allowlisted: (list) => list.includes(`${hostKey}:${port}`) };
}

/**
 * Static check for configuration (saving an MCP / provider / OpenAPI base URL / webhook): scheme, IP literals
 * (any encoding) and localhost-style names. No DNS: names are resolved and checked when the request is made.
 */
export function assertOutboundUrlStatic(raw: string | URL, options: OutboundOptions = {}): URL {
  const target = parseTarget(raw);
  const where = { protocol: target.url.protocol, host: target.host, port: target.port };
  if (target.allowlisted(options.allowlist ?? configuredAllowlist())) return target.url;
  if (isIP(target.host)) {
    if (isBlockedAddress(target.host)) throw refuse(where, classifyBlockedAddress(target.host), [target.host], 0);
  } else if (isLocalHostname(target.host)) {
    throw refuse(where, "local_hostname", [], 0);
  }
  return target.url;
}

/** Full check before a request: static rules + DNS, every answer must be public. Returns the answers to pin the socket to. */
export async function assertOutboundAllowed(raw: string | URL, options: OutboundOptions = {}): Promise<{ url: URL; addresses: OutboundAddress[]; allowlisted: boolean }> {
  return checkOutbound(raw, options, 0);
}

async function checkOutbound(raw: string | URL, options: OutboundOptions, hop: number): Promise<{ url: URL; addresses: OutboundAddress[]; allowlisted: boolean }> {
  const target = parseTarget(raw, hop);
  const where = { protocol: target.url.protocol, host: target.host, port: target.port };
  if (target.allowlisted(options.allowlist ?? configuredAllowlist())) return { url: target.url, addresses: [], allowlisted: true };
  const family = isIP(target.host);
  if (family) {
    if (isBlockedAddress(target.host)) throw refuse(where, classifyBlockedAddress(target.host), [target.host], hop);
    return { url: target.url, addresses: [{ address: target.host, family: family === 6 ? 6 : 4 }], allowlisted: false };
  }
  if (isLocalHostname(target.host)) throw refuse(where, "local_hostname", [], hop);
  const addresses = await resolver(target.host);
  if (!addresses.length) throw new ForgeError("HTP-4002", "目标地址无法解析", 502, undefined, true);
  const bad = addresses.find((a) => isBlockedAddress(a.address));
  if (bad) throw refuse(where, classifyBlockedAddress(bad.address), addresses.map((a) => a.address), hop);
  return { url: target.url, addresses, allowlisted: false };
}

/** A net/http `lookup` that only ever answers with the already-validated addresses (DNS rebinding protection). */
export function createPinnedLookup(addresses: OutboundAddress[]): LookupFunction {
  return ((_hostname: string, options: unknown, callback: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (err: Error | null, address?: unknown, family?: number) => void;
    const opts = (typeof options === "object" && options ? options : {}) as { all?: boolean; family?: number | string };
    const wanted = opts.family === 6 || opts.family === "IPv6" ? 6 : opts.family === 4 || opts.family === "IPv4" ? 4 : 0;
    const usable = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
    if (!usable.length) {
      process.nextTick(() => cb(Object.assign(new Error("no validated address"), { code: "ENOTFOUND" })));
      return;
    }
    if (opts.all) process.nextTick(() => cb(null, usable.map((a) => ({ address: a.address, family: a.family }))));
    else process.nextTick(() => cb(null, usable[0]!.address, usable[0]!.family));
  }) as LookupFunction;
}

export interface SafeFetchInit extends OutboundOptions {
  method?: string;
  headers?: Record<string, string> | Headers | Array<[string, string]>;
  body?: string | URLSearchParams | null;
  signal?: AbortSignal | null;
  /** "follow" (default): follow up to maxRedirects, re-validating every hop. "manual": return the 3xx response. "error": throw on 3xx. */
  redirect?: "follow" | "manual" | "error";
  maxRedirects?: number;
}

function requestOnce(url: URL, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal | null }, pinned: OutboundAddress[] | null): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: init.method,
        headers: init.headers,
        signal: init.signal ?? undefined,
        ...(pinned ? { lookup: createPinnedLookup(pinned) } : {}),
      },
      (res) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
        }
        const status = res.statusCode ?? 502;
        const noBody = init.method === "HEAD" || status === 204 || status === 304;
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage, headers }));
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/**
 * fetch() replacement for outbound requests: validates the target (and each redirect hop), pins the socket to the
 * validated addresses, and returns a standard Response (streaming body).
 */
export async function safeFetch(input: string | URL, init: SafeFetchInit = {}): Promise<Response> {
  let url = new URL(String(input));
  let method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init.headers ?? {}).forEach((value, key) => {
    headers[key] = value;
  });
  let body: string | undefined;
  if (init.body instanceof URLSearchParams) {
    body = init.body.toString();
    headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8";
  } else if (typeof init.body === "string") {
    body = init.body;
  }
  headers["accept-encoding"] ??= "identity";
  const maxRedirects = init.maxRedirects ?? MAX_REDIRECTS;
  for (let hop = 0; ; hop += 1) {
    const target = await checkOutbound(url, init, hop);
    const requestHeaders = { ...headers };
    if (body !== undefined) requestHeaders["content-length"] = String(Buffer.byteLength(body));
    const response = await requestOnce(url, { method, headers: requestHeaders, body, signal: init.signal }, target.allowlisted ? null : target.addresses);
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location || init.redirect === "manual") return response;
    await response.body?.cancel().catch(() => undefined);
    if (init.redirect === "error") throw new ForgeError("HTP-4001", "目标地址返回了重定向", 502);
    if (hop >= maxRedirects) throw new ForgeError("HTP-4001", "重定向次数过多", 502);
    const next = new URL(location, url);
    if (next.origin !== url.origin) {
      delete headers.authorization;
      delete headers.cookie;
    }
    url = next;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = method === "HEAD" ? "HEAD" : "GET";
      body = undefined;
      delete headers["content-type"];
    }
  }
}
