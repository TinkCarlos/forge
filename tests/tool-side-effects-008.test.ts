import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentSpec } from "@forge/core";
import { builtinTools, isReadOnlyHttpMethod, isReadOnlyMcpTool, parseOpenApi, resolveTools } from "@forge/capabilities";
import { execute, pool, query, repos } from "@forge/store";

// TK-07 / TK-08 / TK-08a (r5): tools declare readOnly (default: has side effects), tool_calls snapshot it, resync
// upserts by name and disables tools removed upstream, and migration 008 only adds columns with ALGORITHM=INSTANT.
// Runs only against the vitest database (globalSetup / db.ts pin it to a *_test name).
const root = path.resolve(import.meta.dirname, "..");
const migrate = () =>
  execFileSync(path.join(root, "node_modules/.bin/tsx"), ["scripts/migrate.ts"], { cwd: root, env: { ...process.env, NODE_ENV: "test" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const probeTables: string[] = [];
// Loaded lazily so each case reports its own result.
const migration008 = () => import("../scripts/migrate-008");
const sourceIds: string[] = [];
const serverIds: string[] = [];

afterAll(async () => {
  for (const table of probeTables) await execute(`DROP TABLE IF EXISTS \`${table}\``);
  for (const id of sourceIds) await execute("DELETE FROM tool_sources WHERE id = ?", [id]);
  for (const id of serverIds) await execute("DELETE FROM mcp_servers WHERE id = ?", [id]);
});

describe("TK-07: readOnly declaration", () => {
  it("TK-07: OpenAPI GET/HEAD are read-only, every other method has side effects", () => {
    for (const method of ["GET", "get", "HEAD", "head"]) expect(isReadOnlyHttpMethod(method)).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", ""]) expect(isReadOnlyHttpMethod(method)).toBe(false);
    const parsed = parseOpenApi({
      paths: { "/a": { get: { operationId: "a_get" }, post: { operationId: "a_post" }, put: { operationId: "a_put" }, patch: { operationId: "a_patch" }, delete: { operationId: "a_delete" } } },
    }, "https://api.example.com");
    const readOnly = Object.fromEntries(parsed.tools.map((tool) => [tool.name, tool.readOnly]));
    expect(readOnly).toEqual({ a_get: true, a_post: false, a_put: false, a_patch: false, a_delete: false });
  });

  it("TK-07: MCP is read-only only with readOnlyHint === true and destructiveHint !== true", () => {
    expect(isReadOnlyMcpTool({ readOnlyHint: true })).toBe(true);
    expect(isReadOnlyMcpTool({ readOnlyHint: true, destructiveHint: false })).toBe(true);
    expect(isReadOnlyMcpTool({ readOnlyHint: true, destructiveHint: true })).toBe(false);
    expect(isReadOnlyMcpTool({ readOnlyHint: "true" })).toBe(false);
    expect(isReadOnlyMcpTool({ readOnlyHint: 1 })).toBe(false);
    expect(isReadOnlyMcpTool({})).toBe(false);
    expect(isReadOnlyMcpTool(undefined)).toBe(false);
  });

  it("TK-07: builtins current_time / echo / web_fetch are read-only; readOnly is not in the model tool schema", () => {
    const builtins = builtinTools();
    for (const name of ["current_time", "echo", "web_fetch"]) {
      expect(builtins.get(name)?.readOnly).toBe(true);
      expect(builtins.get(name)?.definition).not.toHaveProperty("readOnly");
    }
  });

  it("TK-07: resolveTools reads read_only from the stored OpenAPI / MCP rows", async () => {
    const sourceKey = `tk07-src-${suffix}`;
    const sourceId = await repos.createToolSource({ key: sourceKey, name: "tk07", baseUrl: "https://api.example.com", spec: { paths: {} } });
    sourceIds.push(sourceId);
    await repos.replaceTools(sourceId, [
      { name: "read", operationId: "read", method: "GET", path: "/r", readOnly: true },
      { name: "write", operationId: "write", method: "POST", path: "/w", readOnly: false, risk: "high" },
    ]);
    const serverKey = `tk07-mcp-${suffix}`;
    const serverId = await repos.createMcpServer({ key: serverKey, name: "tk07", url: "https://mcp.example.com/m", headers: {}, transport: "http" });
    serverIds.push(serverId);
    await repos.replaceMcpTools(serverId, [
      { name: "look", risk: "low", readOnly: true },
      { name: "poke", risk: "medium" },
    ]);
    const spec = { model: { provider: "p", model: "m" }, toolsets: [{ openapi: sourceKey }, { mcp: serverKey }] } as unknown as AgentSpec;
    const tools = await resolveTools(spec);
    const byName = (suffixName: string) => [...tools.entries()].find(([key]) => key.endsWith(`_${suffixName}`))?.[1];
    expect(byName("read")?.readOnly).toBe(true);
    expect(byName("write")?.readOnly).toBe(false);
    expect(byName("look")?.readOnly).toBe(true);
    expect(byName("poke")?.readOnly).toBe(false);
    for (const tool of tools.values()) expect(tool.definition).not.toHaveProperty("readOnly");
  });
});

describe("TK-08: migration 008 and resync", () => {
  it("TK-08: migrate runs twice on the _test DB, records 008 once and adds the approved columns", { timeout: 60_000 }, async () => {
    const first = migrate();
    const second = migrate();
    expect(first + second).toMatch(/008_tool_side_effects (applied|already applied)/);
    expect(second).toContain("Migration 008_tool_side_effects already applied");
    const versions = await query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = ?", ["008_tool_side_effects"]);
    expect(versions).toHaveLength(1);
    const columns = await query<{ TABLE_NAME: string; COLUMN_NAME: string; COLUMN_TYPE: string; IS_NULLABLE: string; COLUMN_DEFAULT: string | null }>(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME IN ('tools','mcp_tools','tool_calls') AND COLUMN_NAME = 'read_only')
         OR (TABLE_NAME = 'approvals' AND COLUMN_NAME = 'reason') OR (TABLE_NAME = 'tool_calls' AND COLUMN_NAME IN ('call_id','model_step','step_index')))
       ORDER BY TABLE_NAME, COLUMN_NAME`,
    );
    expect(columns.map((c) => [c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT])).toEqual([
      ["approvals", "reason", "varchar(16)", "NO", "policy"],
      ["mcp_tools", "read_only", "tinyint(1)", "NO", "0"],
      ["tool_calls", "call_id", "varchar(191)", "YES", null],
      ["tool_calls", "model_step", "int unsigned", "YES", null],
      ["tool_calls", "read_only", "tinyint(1)", "NO", "0"],
      ["tool_calls", "step_index", "int unsigned", "YES", null],
      ["tools", "read_only", "tinyint(1)", "NO", "0"],
    ]);
  });

  it("TK-08: OpenAPI resync upserts by name (keeps id), disables removed tools and re-enables them when they return", async () => {
    const sourceId = await repos.createToolSource({ key: `tk08-src-${suffix}`, name: "tk08", baseUrl: "https://api.example.com", spec: { paths: {} } });
    sourceIds.push(sourceId);
    const rows = () => query<{ id: string; name: string; method: string; read_only: number; enabled: number; description: string }>("SELECT id, name, method, read_only, enabled, description FROM tools WHERE source_id = ? ORDER BY name", [sourceId]);
    await repos.replaceTools(sourceId, [
      { name: "a", operationId: "a", method: "GET", path: "/a", readOnly: true },
      { name: "b", operationId: "b", method: "POST", path: "/b", readOnly: false },
    ]);
    const before = await rows();
    await repos.replaceTools(sourceId, [{ name: "a", operationId: "a", method: "POST", path: "/a2", description: "changed", readOnly: false }]);
    const middle = await rows();
    expect(middle.map((r) => [r.name, r.id, r.method, Number(r.read_only), Number(r.enabled), r.description])).toEqual([
      ["a", before[0]!.id, "POST", 0, 1, "changed"],
      ["b", before[1]!.id, "POST", 0, 0, ""],
    ]);
    await repos.replaceTools(sourceId, [
      { name: "a", operationId: "a", method: "GET", path: "/a", readOnly: true },
      { name: "b", operationId: "b", method: "POST", path: "/b", readOnly: false },
    ]);
    const after = await rows();
    expect(after.map((r) => [r.name, r.id, Number(r.read_only), Number(r.enabled)])).toEqual([
      ["a", before[0]!.id, 1, 1],
      ["b", before[1]!.id, 0, 1],
    ]);
    await repos.replaceTools(sourceId, []);
    expect((await rows()).map((r) => Number(r.enabled))).toEqual([0, 0]);
  });

  it("TK-08: MCP resync upserts by name (keeps id), disables removed tools and re-enables them", async () => {
    const serverId = await repos.createMcpServer({ key: `tk08-mcp-${suffix}`, name: "tk08", url: "https://mcp.example.com/m", headers: {}, transport: "http" });
    serverIds.push(serverId);
    const rows = () => query<{ id: string; name: string; read_only: number; enabled: number; risk_level: string }>("SELECT id, name, read_only, enabled, risk_level FROM mcp_tools WHERE server_id = ? ORDER BY name", [serverId]);
    await repos.replaceMcpTools(serverId, [{ name: "x", risk: "low", readOnly: true }, { name: "y", risk: "medium" }]);
    const before = await rows();
    await repos.replaceMcpTools(serverId, [{ name: "x", risk: "high", readOnly: false }]);
    expect((await rows()).map((r) => [r.name, r.id, r.risk_level, Number(r.read_only), Number(r.enabled)])).toEqual([
      ["x", before[0]!.id, "high", 0, 1],
      ["y", before[1]!.id, "medium", 0, 0],
    ]);
    await repos.replaceMcpTools(serverId, [{ name: "y", risk: "low", readOnly: true }]);
    expect((await rows()).map((r) => [r.name, r.id, Number(r.read_only), Number(r.enabled)])).toEqual([
      ["x", before[0]!.id, 0, 0],
      ["y", before[1]!.id, 1, 1],
    ]);
  });

  it("TK-08: addToolCall stores the readOnly snapshot (default 0 = has side effects)", async () => {
    const agentId = await repos.createAgent({ key: `it-tk08-${suffix}`, name: "IT TK08", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
    const versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "p", model: "m" } }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
    const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: `tk08-${suffix}` });
    const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, subjectType: "user", subjectId: `tk08-${suffix}`, input: {} });
    try {
      const ro = await repos.addToolCall({ runId, toolKey: "echo", args: {}, risk: "low", readOnly: true });
      const rw = await repos.addToolCall({ runId, toolKey: "w", args: {}, risk: "low" });
      expect(Number((await repos.getToolCall(ro))?.read_only)).toBe(1);
      expect(Number((await repos.getToolCall(rw))?.read_only)).toBe(0);
    } finally {
      await execute("DELETE FROM runs WHERE id = ?", [runId]);
      await execute("DELETE FROM threads WHERE id = ?", [threadId]);
      await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
      await execute("DELETE FROM agents WHERE id = ?", [agentId]);
    }
  });
});

describe("TK-08a: 008 on pre-008 rows, idempotent, INSTANT only", () => {
  const names = { tools: `p008_${suffix}_tools`, mcpTools: `p008_${suffix}_mcp`, toolCalls: `p008_${suffix}_tc`, approvals: `p008_${suffix}_apr` };

  it("TK-08a: rows written before 008 read reason='policy' and GET/HEAD tools are backfilled; a re-run changes nothing", async () => {
    probeTables.push(...Object.values(names));
    // 007-shaped copies (no 008 columns) inside the _test DB; dropped in afterAll.
    await execute(`CREATE TABLE \`${names.approvals}\` (id CHAR(26) NOT NULL PRIMARY KEY, status VARCHAR(16) NOT NULL DEFAULT 'pending', risk_level VARCHAR(16) NOT NULL) ENGINE=InnoDB`);
    await execute(`CREATE TABLE \`${names.tools}\` (id CHAR(26) NOT NULL PRIMARY KEY, method VARCHAR(8) NOT NULL, enabled TINYINT(1) NOT NULL DEFAULT 1) ENGINE=InnoDB`);
    await execute(`CREATE TABLE \`${names.mcpTools}\` (id CHAR(26) NOT NULL PRIMARY KEY, name VARCHAR(128) NOT NULL) ENGINE=InnoDB`);
    await execute(`CREATE TABLE \`${names.toolCalls}\` (id CHAR(26) NOT NULL PRIMARY KEY, status VARCHAR(24) NOT NULL) ENGINE=InnoDB`);
    await execute(`INSERT INTO \`${names.approvals}\` (id, risk_level) VALUES ('apr_old', 'high')`);
    await execute(`INSERT INTO \`${names.tools}\` (id, method) VALUES ('t_get', 'GET'), ('t_head', 'HEAD'), ('t_post', 'POST'), ('t_del', 'DELETE')`);
    await execute(`INSERT INTO \`${names.toolCalls}\` (id, status) VALUES ('tc_old', 'running')`);
    const conn = await pool.getConnection();
    try {
      const { applyToolSideEffects } = await migration008();
      await applyToolSideEffects(conn, names);
      const snapshot = async () => ({
        approvals: await query(`SELECT id, reason FROM \`${names.approvals}\` ORDER BY id`),
        tools: await query(`SELECT id, read_only FROM \`${names.tools}\` ORDER BY id`),
        toolCalls: await query(`SELECT id, read_only, call_id, model_step, step_index FROM \`${names.toolCalls}\` ORDER BY id`),
      });
      const first = await snapshot();
      expect(first.approvals).toEqual([{ id: "apr_old", reason: "policy" }]);
      expect(first.tools).toEqual([{ id: "t_del", read_only: 0 }, { id: "t_get", read_only: 1 }, { id: "t_head", read_only: 1 }, { id: "t_post", read_only: 0 }]);
      expect(first.toolCalls).toEqual([{ id: "tc_old", read_only: 0, call_id: null, model_step: null, step_index: null }]);
      // An old-code insert without reason still gets 'policy'.
      await execute(`INSERT INTO \`${names.approvals}\` (id, risk_level) VALUES ('apr_new', 'low')`);
      await execute(`DELETE FROM \`${names.approvals}\` WHERE id = 'apr_new'`);
      await applyToolSideEffects(conn, names);
      expect(await snapshot()).toEqual(first);
    } finally {
      conn.release();
    }
  });

  it("TK-08a: the 008 column helper refuses a non-INSTANT change instead of copying the table", async () => {
    const table = `p008_${suffix}_ft`;
    probeTables.push(table);
    await execute(`CREATE TABLE \`${table}\` (id INT NOT NULL PRIMARY KEY, body TEXT NOT NULL, FULLTEXT KEY ft_body (body)) ENGINE=InnoDB`);
    const conn = await pool.getConnection();
    try {
      const { addColumnInstant } = await migration008();
      await expect(addColumnInstant(conn, table, "read_only", "TINYINT(1) NOT NULL DEFAULT 0")).rejects.toMatchObject({ code: "ER_ALTER_OPERATION_NOT_SUPPORTED_REASON" });
      const [rows] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'read_only'", [table]);
      expect(Number((rows as Array<{ n: number }>)[0]?.n)).toBe(0);
    } finally {
      conn.release();
    }
  });
});
