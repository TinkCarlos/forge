import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { AgentSpec } from "@forge/core";
import { resolveTools } from "@forge/capabilities";
import { callModel } from "@forge/models";
import { buildSystemPrompt } from "../packages/runtime/src/context";
import { execute, repos } from "@forge/store";

// Item A, manifest (needs a *_test DB): a plugin whose stored manifest_json is not a JSON object is unusable. Nothing it
// installed is loaded: its MCP tools are not in the tool list (so a call to them is not authorised either), its skills
// are not in the system prompt, its providers cannot be called. Other plugins are unaffected. One warning per broken
// plugin naming table, column and plugin id only.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const k = (tag: string): string => `it-pmi-${tag}-${suffix}`;
const LEAK = `{"name":"leak-${suffix}"`; // truncated: invalid JSON
const ids: Record<string, string> = {};
const pluginIds: string[] = [];

async function bundle(tag: string): Promise<{ mcp: string[]; skills: string[]; providers: string[] }> {
  const mcp = await repos.createMcpServer({ key: k(`mcp-${tag}`), name: tag, url: "https://mcp.example.com/m", headers: {}, transport: "http" });
  await repos.replaceMcpTools(mcp, [{ name: "lookup", description: "d", inputSchema: { type: "object", properties: {} }, risk: "low" }]);
  const skill = await repos.createSkill({ key: k(`skill-${tag}`), name: tag, content: `SKILL-${tag}-${suffix}`, publish: true });
  const provider = await repos.createProvider({ key: k(`prov-${tag}`), name: tag, protocol: "mock", baseUrl: "https://llm.example.com/v1", apiKeyEncrypted: null, headers: {}, timeoutMs: 120000 });
  await repos.createModel({ providerId: provider, key: "mock-1", displayName: "mock-1", capabilities: ["text", "tools"] });
  Object.assign(ids, { [`mcp-${tag}`]: mcp, [`skill-${tag}`]: skill, [`prov-${tag}`]: provider });
  return { mcp: [mcp], skills: [skill], providers: [provider] };
}

beforeAll(async () => {
  for (const tag of ["bad", "arr", "ok"]) {
    const resources = await bundle(tag);
    pluginIds.push(await repos.createPlugin({ key: k(`plg-${tag}`), version: "1.0.0", type: "mixed", name: tag, manifest: { name: tag }, resources }));
  }
  await execute("UPDATE plugins SET manifest_json = JSON_QUOTE(?) WHERE id = ?", [LEAK, pluginIds[0]]); // text that does not parse
  await execute("UPDATE plugins SET manifest_json = ? WHERE id = ?", ["[1]", pluginIds[1]]); // valid JSON, not an object
});

afterAll(async () => {
  await execute("DELETE FROM plugins WHERE id IN (?, ?, ?)", pluginIds);
  for (const tag of ["bad", "arr", "ok"]) {
    await execute("DELETE FROM mcp_servers WHERE id = ?", [ids[`mcp-${tag}`]]);
    await execute("UPDATE skills SET published_version_id = NULL WHERE id = ?", [ids[`skill-${tag}`]]);
    await execute("DELETE FROM skill_versions WHERE skill_id = ?", [ids[`skill-${tag}`]]);
    await execute("DELETE FROM skills WHERE id = ?", [ids[`skill-${tag}`]]);
    await execute("DELETE FROM llm_providers WHERE id = ?", [ids[`prov-${tag}`]]);
  }
});

const spec = (tags: string[]): AgentSpec => ({ model: { provider: "mock", model: "mock-1" }, toolsets: tags.map((t) => ({ mcp: k(`mcp-${t}`) })), skills: tags.map((t) => k(`skill-${t}`)) }) as unknown as AgentSpec;

describe("plugin with an invalid stored manifest is not loaded", () => {
  it("tool list: only the healthy plugin's MCP tools", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = [...(await resolveTools(spec(["bad", "arr", "ok"]))).keys()];
    expect(tools.some((name) => name.includes(k("mcp-ok")))).toBe(true);
    expect(tools.some((name) => name.includes(k("mcp-bad")) || name.includes(k("mcp-arr")))).toBe(false);
    const lines = warn.mock.calls.map((c) => c.join(" ")).filter((line) => line.includes("manifest_json"));
    expect(lines.some((line) => line.includes(pluginIds[0]!))).toBe(true);
    expect(lines.some((line) => line.includes(pluginIds[1]!))).toBe(true);
    expect(lines.some((line) => line.includes(pluginIds[2]!))).toBe(false);
    expect(lines.join("\n")).not.toContain("leak-");
    warn.mockRestore();
  });

  it("system prompt: only the healthy plugin's skill", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prompt = await buildSystemPrompt("base", spec(["bad", "arr", "ok"]));
    expect(prompt).toContain(`SKILL-ok-${suffix}`);
    expect(prompt).not.toContain(`SKILL-bad-${suffix}`);
    expect(prompt).not.toContain(`SKILL-arr-${suffix}`);
    warn.mockRestore();
  });

  it("models: the broken plugin's providers cannot be called, the healthy one can", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const call = (tag: string) => callModel({ providerKey: k(`prov-${tag}`), modelKey: "mock-1", messages: [{ role: "user", content: "hi" }], tools: [] });
    await expect(call("bad")).rejects.toMatchObject({ code: "MDL-3001" });
    await expect(call("arr")).rejects.toMatchObject({ code: "MDL-3001" });
    await expect(call("ok")).resolves.toBeTruthy();
    warn.mockRestore();
  });
});
