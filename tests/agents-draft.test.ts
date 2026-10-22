import { afterAll, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { execute, repos } from "@forge/store";

const agentA = ulid();
const agentB = ulid();
const versions = { a1: ulid(), a2: ulid(), aPub: ulid() };

afterAll(async () => {
  await execute("DELETE FROM agent_versions WHERE agent_id IN (?, ?)", [agentA, agentB]);
  await execute("DELETE FROM agents WHERE id IN (?, ?)", [agentA, agentB]);
});

describe("repos.latestDraftVersions", () => {
  it("returns the newest draft per agent and nothing for agents without drafts", async () => {
    const suffix = agentA.slice(-8).toLowerCase();
    await execute("INSERT INTO agents (id, `key`, name) VALUES (?, ?, ?), (?, ?, ?)", [
      agentA, `draft-test-a-${suffix}`, "Draft test A",
      agentB, `draft-test-b-${suffix}`, "Draft test B",
    ]);
    const insert = "INSERT INTO agent_versions (id, agent_id, version, status, instructions, spec_json, created_at) VALUES (?, ?, ?, ?, '', '{}', ?)";
    await execute(insert, [versions.aPub, agentA, "1", "published", "2026-01-01 00:00:00.000"]);
    await execute(insert, [versions.a1, agentA, "2", "draft", "2026-01-02 00:00:00.000"]);
    await execute(insert, [versions.a2, agentA, "3", "draft", "2026-01-03 00:00:00.000"]);

    const drafts = await repos.latestDraftVersions([agentA, agentB]);
    expect(drafts.get(agentA)).toEqual({ id: versions.a2, version: "3" });
    expect(drafts.has(agentB)).toBe(false);
    expect((await repos.latestDraftVersions([])).size).toBe(0);
  });
});
