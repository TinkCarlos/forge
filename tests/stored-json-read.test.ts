import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { literalHeaders, storedJsonObject } from "@forge/core";
import { executeRun } from "@forge/runtime";
import { execute, repos } from "@forge/store";

// Item 7, read side (needs a *_test DB for the Run case): a stored `spec_json` / `headers_json` holding JSON text that
// does not parse to an object (only possible as a JSON string value written by older code or by hand) is treated as {}
// and logged as one warning that names the table, column and record id only (never the stored text).
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const SECRET_TEXT = `{"Authorization":"Bearer leak-${suffix}"`; // truncated object: invalid JSON
let agentId = "";

afterEach(() => vi.restoreAllMocks());

describe("storedJsonObject", () => {
  it("objects pass through, valid object text is parsed, null/undefined are {} without a warning", () => {
    const warn = vi.fn();
    const ref = { table: "t", column: "c", id: "id-1" };
    expect(storedJsonObject({ a: 1 }, ref, warn)).toEqual({ a: 1 });
    expect(storedJsonObject("{\"a\":1}", ref, warn)).toEqual({ a: 1 });
    expect(storedJsonObject(null, ref, warn)).toEqual({});
    expect(storedJsonObject(undefined, ref, warn)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([SECRET_TEXT, "[1]", "\"x\"", "42"])("%j -> {} and one warning with the record id only", (raw) => {
    const warn = vi.fn();
    expect(storedJsonObject(raw, { table: "mcp_servers", column: "headers_json", id: "rec-9" }, warn)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("rec-9");
    expect(logged).not.toContain("leak-");
    expect(logged).not.toContain(raw);
  });

  it("literalHeaders with a record ref warns (console.warn) without the stored text", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(literalHeaders(SECRET_TEXT, { table: "llm_providers", column: "headers_json", id: "prov-7" })).toEqual({});
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("prov-7");
    expect(logged).not.toContain("leak-");
  });
});

describe("Run with a stored invalid spec_json", () => {
  beforeAll(async () => {
    agentId = await repos.createAgent({ key: `it-sjr-${suffix}`, name: "IT sjr", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  });
  afterAll(async () => {
    await execute("DELETE e FROM run_events e JOIN runs r ON r.id = e.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE m FROM messages m JOIN runs r ON r.id = m.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE s FROM run_steps s JOIN runs r ON r.id = s.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  });

  it("spec is treated as {}: one warning naming the version id, stored text never logged", async () => {
    const versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: SECRET_TEXT, status: "published", createdBy: ADMIN_ID });
    const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
    const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "hi" } });
    await repos.addMessage({ threadId, runId, seq: 1, role: "user", content: { text: "hi" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await executeRun(runId, `w-sjr-${suffix}`);
    const warned = warn.mock.calls.map((c) => c.join(" ")).filter((line) => line.includes("spec_json"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(versionId);
    const allLogs = [...warn.mock.calls, ...error.mock.calls].map((c) => c.join(" ")).join("\n");
    expect(allLogs).not.toContain("leak-");
    // {} has no model: the Run fails cleanly with CFG-8501 instead of a TypeError.
    const run = await repos.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error_code).toBe("CFG-8501");
    const events = JSON.stringify(await repos.listEvents(runId, 0));
    expect(events).not.toContain("leak-");
  });
});
