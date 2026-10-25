import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedTool } from "@forge/capabilities";
import { execute, one, query } from "@forge/store";

// Test stub: tools that IGNORE the abort signal. execute() blocks for `hangMs` whatever the signal says, then returns
// ok, so a drain / lease-loss abort cannot end the call early (models a tool or client that does not honour abort).
//
// - `effect` (side effects, readOnly false): every execution writes one row to the test DB table
//   test_tool_stub_effects (kind 'effect'), by default when it starts (the side effect is "sent"), so a process that
//   dies during the hang still counted it. sideEffectCount() is what tests assert "ran exactly once" on.
// - `read` (read-only): writes a kind 'read' row (an execution count, not a side effect).
//
// In-process (vitest): put hangingTools(...) into the map resolveTools returns (vi.mock("@forge/capabilities")).
// Child process (API / worker spawned with node --import tsx): spread hangingToolChildEnv(...) into the child's env;
// the child then resolves @forge/capabilities to tests/helpers/hanging-tool-capabilities.ts, which adds the two stub
// tools to every resolveTools result. The model (a stub) calls them by hangingToolNames(key).
export const STUB_EFFECTS_TABLE = "test_tool_stub_effects";
export const HANGING_TOOLS_ENV = "FORGE_TEST_HANGING_TOOLS";

export interface HangingToolOptions {
  /** Distinguishes stubs (tool names and the count rows); letters, digits, _ and - only. */
  key: string;
  /** How long execute() blocks, ignoring the abort signal. */
  hangMs: number;
  /** Risk of both tools; "low" (default) runs without approval. */
  risk?: "low" | "medium" | "high";
  /** When the effect row is written: "start" (default) or "end" (after the hang, only if the process is still alive). */
  effectAt?: "start" | "end";
}

export function hangingToolNames(key: string): { effect: string; read: string } {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  return { effect: `stub_${safe}_effect`, read: `stub_${safe}_read` };
}

export async function ensureStubEffectsTable(): Promise<void> {
  await execute(
    `CREATE TABLE IF NOT EXISTS ${STUB_EFFECTS_TABLE} (
       id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       stub_key VARCHAR(64) NOT NULL,
       kind VARCHAR(8) NOT NULL,
       tool VARCHAR(128) NOT NULL,
       idempotency_key VARCHAR(255) NULL,
       pid INT NOT NULL,
       signal_aborted TINYINT(1) NOT NULL DEFAULT 0,
       created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       KEY idx_stub_key (stub_key, kind)
     ) ENGINE=InnoDB`,
  );
}

async function record(key: string, kind: "effect" | "read", tool: string, idempotencyKey: string | undefined, signal: AbortSignal | undefined): Promise<void> {
  await execute(
    `INSERT INTO ${STUB_EFFECTS_TABLE} (stub_key, kind, tool, idempotency_key, pid, signal_aborted) VALUES (?, ?, ?, ?, ?, ?)`,
    [key, kind, tool, idempotencyKey ?? null, process.pid, signal?.aborted ? 1 : 0],
  );
}

/** Real side effects (kind 'effect') recorded for `key`. */
export async function sideEffectCount(key: string): Promise<number> {
  return Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${STUB_EFFECTS_TABLE} WHERE stub_key = ? AND kind = 'effect'`, [key]))?.n ?? 0);
}

/** Executions of the read-only stub (kind 'read') recorded for `key`. */
export async function readCount(key: string): Promise<number> {
  return Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${STUB_EFFECTS_TABLE} WHERE stub_key = ? AND kind = 'read'`, [key]))?.n ?? 0);
}

/** Rows for `key`, oldest first (pid tells which process ran it). */
export async function stubEffects(key: string): Promise<Array<{ kind: string; tool: string; idempotency_key: string | null; pid: number; created_at: Date }>> {
  return query(`SELECT kind, tool, idempotency_key, pid, created_at FROM ${STUB_EFFECTS_TABLE} WHERE stub_key = ? ORDER BY id`, [key]);
}

export async function cleanupStubEffects(key: string): Promise<void> {
  await execute(`DELETE FROM ${STUB_EFFECTS_TABLE} WHERE stub_key = ?`, [key]);
}

/** Blocks `ms`, deliberately not listening to any abort signal. */
function hang(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The two stub tools, keyed by tool name (merge into a resolveTools map). */
export function hangingTools(options: HangingToolOptions): Map<string, ResolvedTool> {
  const names = hangingToolNames(options.key);
  const risk = options.risk ?? "low";
  const effectAt = options.effectAt ?? "start";
  const tools = new Map<string, ResolvedTool>();
  tools.set(names.effect, {
    definition: { name: names.effect, description: "test stub with side effects; ignores abort", parameters: { type: "object", properties: {} }, risk },
    readOnly: false,
    execute: async (_args, context) => {
      if (effectAt === "start") await record(options.key, "effect", names.effect, context?.idempotencyKey, context?.signal);
      await hang(options.hangMs);
      if (effectAt === "end") await record(options.key, "effect", names.effect, context?.idempotencyKey, context?.signal);
      return { ok: true, content: "stub effect done" };
    },
  });
  tools.set(names.read, {
    definition: { name: names.read, description: "read-only test stub; ignores abort", parameters: { type: "object", properties: {} }, risk },
    readOnly: true,
    execute: async (_args, context) => {
      await record(options.key, "read", names.read, context?.idempotencyKey, context?.signal);
      await hang(options.hangMs);
      return { ok: true, content: "stub read done" };
    },
  });
  return tools;
}

/**
 * Env for a child started with `node --import tsx ...`: a generated tsconfig (temp dir) maps @forge/capabilities to
 * hanging-tool-capabilities.ts, and the options travel in FORGE_TEST_HANGING_TOOLS (several stubs: pass an array, one
 * key each). Call ensureStubEffectsTable() first.
 */
export function hangingToolChildEnv(options: HangingToolOptions | HangingToolOptions[]): Record<string, string> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const base = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as { compilerOptions: { paths: Record<string, string[]> } };
  const paths = { ...base.compilerOptions.paths, "@forge/capabilities": ["tests/helpers/hanging-tool-capabilities.ts"] };
  const dir = mkdtempSync(join(tmpdir(), "forge-hanging-tool-"));
  const file = join(dir, "tsconfig.json");
  writeFileSync(file, JSON.stringify({ extends: join(root, "tsconfig.json"), compilerOptions: { baseUrl: root, paths } }));
  return { TSX_TSCONFIG_PATH: file, [HANGING_TOOLS_ENV]: JSON.stringify(options) };
}
