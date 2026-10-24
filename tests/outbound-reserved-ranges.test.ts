import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertOutboundAllowed, assertOutboundUrlStatic, OUTBOUND_BLOCKED_CODE, setOutboundLogger, setOutboundResolver, type OutboundBlockLog } from "@forge/core";

// P2-04b: reserved IPv4 ranges incl. TEST-NET-1/2/3 (192.0.2/24, 198.51.100/24, 203.0.113/24). DNS faked.
const dns = new Map<string, string>();
const logs: OutboundBlockLog[] = [];
beforeAll(() => {
  setOutboundResolver(async (host) => {
    const address = dns.get(host);
    if (!address) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return [{ address, family: 4 }];
  });
  setOutboundLogger((e) => logs.push(e));
});
afterAll(() => {
  setOutboundResolver(null);
  setOutboundLogger(null);
});

async function viaDns(address: string): Promise<string> {
  const name = `r${dns.size}.reserved.test`;
  dns.set(name, address);
  try {
    await assertOutboundAllowed(`https://${name}/x`, { allowlist: [] });
    return "allowed";
  } catch (error) {
    return (error as { code?: string }).code === OUTBOUND_BLOCKED_CODE ? "blocked" : "other";
  }
}
function literal(address: string): string {
  try {
    assertOutboundUrlStatic(`http://${address}/x`, { allowlist: [] });
    return "allowed";
  } catch (error) {
    return (error as { code?: string }).code === OUTBOUND_BLOCKED_CODE ? "blocked" : "other";
  }
}

describe("P2-04b outbound: reserved IPv4 ranges", () => {
  it.each([
    ["192.0.2.1", "reserved"],
    ["198.51.100.1", "reserved"],
    ["203.0.113.1", "reserved"],
    ["198.18.0.1", "reserved"],
    ["100.64.0.1", "cgnat"],
    ["240.0.0.1", "reserved"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
  ])("%s -> HTP-4003 (DNS and literal), log reason %s", async (address, reason) => {
    expect(await viaDns(address)).toBe("blocked");
    expect(logs.at(-1)).toMatchObject({ reason, addresses: [address] });
    expect(literal(address)).toBe("blocked");
  });

  it.each([
    ["192.0.2.0", "blocked"],
    ["192.0.2.255", "blocked"],
    ["192.0.3.0", "allowed"],
    ["198.51.99.255", "allowed"],
    ["198.51.100.0", "blocked"],
    ["198.51.101.0", "allowed"],
    ["203.0.112.255", "allowed"],
    ["203.0.113.255", "blocked"],
    ["203.0.114.0", "allowed"],
  ])("boundary %s -> %s", async (address, expected) => {
    expect(await viaDns(address)).toBe(expected);
    expect(literal(address)).toBe(expected);
  });
});
