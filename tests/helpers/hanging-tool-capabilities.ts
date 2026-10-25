// Child-process side of tests/helpers/hanging-tool.ts: @forge/capabilities as seen by a child started with
// hangingToolChildEnv(). Everything is the real module; resolveTools additionally returns the two stub tools that
// ignore the abort signal (options from FORGE_TEST_HANGING_TOOLS).
import type { AgentSpec } from "@forge/core";
import { resolveTools as realResolveTools, type ResolvedTool } from "../../packages/capabilities/src/index.ts";
import { HANGING_TOOLS_ENV, hangingTools, type HangingToolOptions } from "./hanging-tool.ts";

export * from "../../packages/capabilities/src/index.ts";

export async function resolveTools(spec: AgentSpec): Promise<Map<string, ResolvedTool>> {
  const tools = await realResolveTools(spec);
  const raw = process.env[HANGING_TOOLS_ENV];
  if (!raw) return tools;
  const parsed = JSON.parse(raw) as HangingToolOptions | HangingToolOptions[];
  for (const options of Array.isArray(parsed) ? parsed : [parsed]) {
    for (const [name, tool] of hangingTools(options)) tools.set(name, tool);
  }
  return tools;
}
