import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertOutboundAllowed, classifyBlockedAddress, OUTBOUND_BLOCKED_CODE, setOutboundLogger, setOutboundResolver, type OutboundBlockLog } from "@forge/core";

// P2-04a: IPv6 addresses that embed an IPv4 address. No network: DNS is faked with setOutboundResolver.
// - Teredo 2001:0::/32: server IPv4 in bits 32-63, client IPv4 = NOT(bits 96-127). Both are extracted and checked
//   against the IPv4 rules; either one blocked -> HTP-4003 (reason ipv4_embedded). Public/public is allowed.
// - 6to4 2002::/16 and NAT64 64:ff9b::/96: kept as whole-range refusals (decision: no 6to4 / NAT64 egress at all),
//   so the public-embedded counterexamples are refused too.
const dns = new Map<string, string>();
const logs: OutboundBlockLog[] = [];
beforeAll(() => {
  setOutboundResolver(async (host) => {
    const address = dns.get(host);
    if (!address) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return [{ address, family: 6 }];
  });
  setOutboundLogger((e) => logs.push(e));
});
afterAll(() => {
  setOutboundResolver(null);
  setOutboundLogger(null);
});

async function outcome(address: string): Promise<{ literal: string; dns: string }> {
  const name = `h${dns.size}.embedded.test`;
  dns.set(name, address);
  const run = async (url: string) => {
    try {
      await assertOutboundAllowed(url, { allowlist: [] });
      return "allowed";
    } catch (error) {
      const e = error as { code?: string; message?: string; statusCode?: number };
      expect(JSON.stringify({ message: e.message })).not.toContain(address);
      return e.code === OUTBOUND_BLOCKED_CODE ? "blocked" : `other:${e.code}`;
    }
  };
  return { literal: await run(`http://[${address}]/x`), dns: await run(`http://${name}/x`) };
}
const both = (v: string) => ({ literal: v, dns: v });

describe("P2-04a outbound: Teredo / 6to4 / NAT64 embedded IPv4", () => {
  it.each([
    ["Teredo client 10.0.0.1", "2001:0:4136:e378:8000:63bf:f5ff:fffe"],
    ["Teredo client 127.0.0.1", "2001:0000:4136:e378:8000:63bf:80ff:fffe"],
    ["Teredo client 169.254.169.254", "2001:0:4136:e378:8000:63bf:5601:5601"],
    ["Teredo server 10.0.0.1 (client public)", "2001:0:a00:1:8000:63bf:f7f7:f7f7"],
    ["6to4 127.0.0.1", "2002:7f00:1::"],
    ["NAT64 127.0.0.1", "64:ff9b::7f00:1"],
    ["NAT64 dotted 10.0.0.1", "64:ff9b::10.0.0.1"],
  ])("%s -> HTP-4003 (literal and via DNS)", async (_name, address) => {
    expect(await outcome(address)).toEqual(both("blocked"));
  });

  it("Teredo with public server and client (65.54.227.120 / 8.8.8.8) is allowed", async () => {
    expect(await outcome("2001:0:4136:e378:8000:63bf:f7f7:f7f7")).toEqual(both("allowed"));
  });

  it("6to4 and NAT64 with a public embedded IPv4 stay refused (whole-range decision)", async () => {
    expect(await outcome("2002:808:808::")).toEqual(both("blocked"));
    expect(await outcome("64:ff9b::808:808")).toEqual(both("blocked"));
  });

  it("log reason for a Teredo-embedded private address is ipv4_embedded", () => {
    expect(classifyBlockedAddress("2001:0:4136:e378:8000:63bf:f5ff:fffe")).toBe("ipv4_embedded");
    expect(logs.some((l) => l.reason === "ipv4_embedded" && l.addresses.includes("2001:0:4136:e378:8000:63bf:f5ff:fffe"))).toBe(true);
  });

  it("other 2001::/16 global unicast is untouched (2001:db8 is documentation, 2001:4860 public)", async () => {
    expect(await outcome("2001:4860:4860::8888")).toEqual(both("allowed"));
  });
});
