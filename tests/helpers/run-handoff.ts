import { expect } from "vitest";

// Ruling 15:39 / 15:41: one `run_handoff` line per drained Run, {phase:"run_handoff", runId, takeover, reason}.
// reason "drained" <=> takeover "released"; "tool_inflight" | "release_timeout" | "release_error" => "lease_expiry".
export type HandoffLine = { phase: string; runId: string; takeover: string; reason: string };

export const HANDOFF_TAKEOVER: Record<string, string> = {
  drained: "released",
  tool_inflight: "lease_expiry",
  release_timeout: "lease_expiry",
  release_error: "lease_expiry",
};

/** Every line: reason is one of the four values and takeover is the one it maps to. */
export function expectHandoffMapping(lines: Array<Partial<HandoffLine>>): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(Object.keys(HANDOFF_TAKEOVER), JSON.stringify(line)).toContain(line.reason);
    expect(line.takeover, JSON.stringify(line)).toBe(HANDOFF_TAKEOVER[line.reason!]);
    expect(typeof line.runId).toBe("string");
  }
}
