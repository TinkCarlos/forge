import { updateConfiguration, type ConfigurationWrite } from "../configuration-revision.js";
import type { RowDataPacket } from "mysql2/promise";
import { errors, ulidWithPrefix } from "@forge/core";
import { execute, json, one, query, transaction } from "../db.js";
import type { AgentRow, AgentVersionRow } from "../types.js";

export const agentsRepo = {
  // Agents / versions
  async listAgents(orgIds: string[] | null): Promise<AgentRow[]> {
    if (orgIds && orgIds.length === 0) return [];
    if (orgIds && orgIds.length > 0) {
      const placeholders = orgIds.map(() => "?").join(",");
      return query<AgentRow>(`SELECT * FROM agents WHERE deleted_at IS NULL AND (owner_org_unit_id IS NULL OR owner_org_unit_id IN (${placeholders})) ORDER BY created_at DESC`, orgIds);
    }
    return query<AgentRow>("SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY created_at DESC");
  },
  async getAgent(id: string): Promise<AgentRow | null> {
    return one<AgentRow>("SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL", [id]);
  },
  async getAgentByKey(key: string): Promise<AgentRow | null> {
    return one<AgentRow>("SELECT * FROM agents WHERE `key` = ? AND deleted_at IS NULL", [key]);
  },
  async createAgent(input: { key: string; name: string; description?: string; ownerOrgUnitId?: string | null; createdBy?: string | null }): Promise<string> {
    const id = ulidWithPrefix("agt");
    await execute(
      "INSERT INTO agents (id, `key`, name, description, owner_org_unit_id, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.key, input.name, input.description ?? "", input.ownerOrgUnitId ?? null, input.createdBy ?? null],
    );
    return id;
  },
  async updateAgent(id: string, fields: Record<string, unknown>, options: ConfigurationWrite): Promise<number> {
    const allowed = ["name","description","status","api_enabled","api_scopes_json","published_version_id","latest_version_id","owner_org_unit_id"];
    const values = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.includes(key)).map(([key, value]) => [key, key.endsWith("_json") ? json(value) : value]));
    return updateConfiguration("agents", id, values, options);
  },
  async listAgentVersions(agentId: string): Promise<AgentVersionRow[]> {
    return query<AgentVersionRow>("SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY created_at DESC", [agentId]);
  },
  /** Newest draft version per agent (same rule as the console: first status='draft' by created_at DESC). */
  async latestDraftVersions(agentIds: string[]): Promise<Map<string, { id: string; version: string }>> {
    const result = new Map<string, { id: string; version: string }>();
    if (agentIds.length === 0) return result;
    const rows = await query<AgentVersionRow>(
      `SELECT id, agent_id, version FROM agent_versions WHERE status = 'draft' AND agent_id IN (${agentIds.map(() => "?").join(", ")}) ORDER BY created_at DESC`,
      agentIds,
    );
    for (const row of rows) if (!result.has(row.agent_id)) result.set(row.agent_id, { id: row.id, version: row.version });
    return result;
  },
  async getAgentVersion(id: string): Promise<AgentVersionRow | null> {
    return one<AgentVersionRow>("SELECT * FROM agent_versions WHERE id = ?", [id]);
  },
  async getPublishedVersion(agentId: string): Promise<AgentVersionRow | null> {
    return one<AgentVersionRow>("SELECT * FROM agent_versions WHERE agent_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1", [agentId]);
  },
  async createAgentVersion(input: {
    agentId: string;
    version: string;
    instructions: string;
    spec: unknown;
    status?: string;
    changelog?: string;
    createdBy?: string | null;
  }, options: ConfigurationWrite): Promise<string> {
    const id = ulidWithPrefix("ver");
    await agentsRepo.updateAgent(input.agentId, { latest_version_id: id, ...(input.status === "published" ? { published_version_id: id } : {}) }, {
      ...options,
      audit: options.audit ? { ...options.audit, resourceId: id } : undefined,
      beforeWrite: async (conn) => {
        await conn.execute("INSERT INTO agent_versions (id, agent_id, version, status, instructions, spec_json, changelog, created_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, input.agentId, input.version, input.status ?? "draft", input.instructions, json(input.spec), input.changelog ?? "", input.createdBy ?? null, input.status === "published" ? new Date() : null]);
        if (options.beforeWrite) await options.beforeWrite(conn);
      },
    });
    return id;
  },
  async publishAgentVersion(agentId: string, versionId: string, options: ConfigurationWrite): Promise<boolean> {
    return transaction(async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>("SELECT published_version_id FROM agents WHERE id = ? FOR UPDATE", [agentId]);
      if (!rows[0]) throw errors.notFound("Agent 不存在");
      const [versions] = await conn.query<RowDataPacket[]>("SELECT id FROM agent_versions WHERE id = ? AND agent_id = ?", [versionId, agentId]);
      if (!versions[0]) throw errors.notFound("版本不存在");
      const changed = rows[0].published_version_id !== versionId;
      await agentsRepo.updateAgent(agentId, changed ? { published_version_id: versionId, latest_version_id: versionId } : {}, {
        ...options, connection: conn, audit: changed ? options.audit : undefined,
        afterWrite: changed ? async (connection) => {
          await connection.execute("UPDATE agent_versions SET status = 'published', published_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND agent_id = ?", [versionId, agentId]);
          if (options.afterWrite) await options.afterWrite(connection);
        } : undefined,
      });
      return changed;
    });
  },
  async publishLatestAgentVersion(agentId: string, versionId: string): Promise<void> {
    await agentsRepo.publishAgentVersion(agentId, versionId, { expectedRevision: "system" });
  },
};
