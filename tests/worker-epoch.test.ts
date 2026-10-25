import os from "node:os";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// r5 §5 EP-01 (needs a *_test DB). claimed_by = hostname:pid:epoch, epoch = 8 hex generated once per process, total
// <= 128 (hostname cut first). Fences compare strings, so a restarted process that reuses host+pid (container pid 1)
// does not own its predecessor's lease; an old-format `host:pid` row with an expired lease is claimable as before.
const { execute, one, repos } = await import("@forge/store");
const { currentWorkerId } = await import("@forge/runtime");

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
let agentId = "";
let versionId = "";

async function newRun(claimedBy: string | null, leaseSeconds: number): Promise<string> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "go" }, status: "queued" });
  await execute("UPDATE runs SET status = 'running', claimed_by = ?, lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND) WHERE id = ?", [claimedBy, leaseSeconds, runId]);
  return runId;
}
const claimedBy = async (runId: string) => (await one<{ claimed_by: string | null }>("SELECT claimed_by FROM runs WHERE id = ?", [runId]))!.claimed_by;

beforeAll(async () => {
  agentId = await repos.createAgent({ key: `it-ep-${suffix}`, name: "IT EP", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "none", model: "none" } }, status: "published", createdBy: ADMIN_ID });
});
afterAll(async () => {
  if (!agentId) return;
  await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
});

describe("EP-01 worker id carries a process epoch", () => {
  it("format hostname:pid:8hex, stable within the process", () => {
    const id = currentWorkerId();
    expect(id).toMatch(new RegExp(`^.+:${process.pid}:[0-9a-f]{8}$`));
    expect(id.startsWith(`${os.hostname()}:`)).toBe(true);
    expect(currentWorkerId()).toBe(id);
  });

  it("a long hostname is cut first: <= 128 chars, pid and epoch kept", () => {
    const spy = vi.spyOn(os, "hostname").mockReturnValue("h".repeat(300));
    try {
      const id = currentWorkerId();
      expect(id.length).toBeLessThanOrEqual(128);
      expect(id).toMatch(new RegExp(`^h+:${process.pid}:[0-9a-f]{8}$`));
    } finally {
      spy.mockRestore();
    }
  });

  it("same host+pid with another epoch is another owner: heartbeat and release do not touch its lease", async () => {
    const mine = currentWorkerId();
    const predecessor = `${mine.slice(0, mine.lastIndexOf(":"))}:${mine.endsWith("00000000") ? "11111111" : "00000000"}`;
    const runId = await newRun(predecessor, 30);
    expect(await repos.heartbeatRun(runId, mine, 30)).toBe(false);
    await repos.releaseRunLease(runId, mine);
    expect(await claimedBy(runId)).toBe(predecessor);
    expect(await repos.claimRun(runId, mine, 30, false)).toBeNull();
  });

  it("an old-format host:pid row with an expired lease is claimable", async () => {
    const mine = currentWorkerId();
    const old = `${os.hostname()}:${process.pid}`;
    const runId = await newRun(old, -5);
    expect(await repos.claimRun(runId, mine, 30, false)).not.toBeNull();
    expect(await claimedBy(runId)).toBe(mine);
    expect(await repos.heartbeatRun(runId, old, 30)).toBe(false);
  });
});
