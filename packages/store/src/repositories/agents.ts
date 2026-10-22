import { ulidWithPrefix } from "@forge/core";
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
  async updateAgent(id: string, fields: Record<string, unknown>): Promise<void> {
    const allowed = ["name", "description", "status", "api_enabled", "api_scopes_json", "published_version_id", "latest_version_id", "owner_org_unit_id"];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      sets.push(`\`${key}\` = ?`);
      params.push(key.endsWith("_json") ? json(value) : value);
    }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async listAgentVersions(agentId: string): Promise<AgentVersionRow[]> {
    return query<AgentVersionRow>("SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY created_at DESC", [agentId]);
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
  }): Promise<string> {
    const id = ulidWithPrefix("ver");
    await execute(
      "INSERT INTO agent_versions (id, agent_id, version, status, instructions, spec_json, changelog, created_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, input.agentId, input.version, input.status ?? "draft", input.instructions, json(input.spec), input.changelog ?? "", input.createdBy ?? null, input.status === "published" ? new Date() : null],
    );
    await agentsRepo.updateAgent(input.agentId, { latest_version_id: id });
    return id;
  },
  async publishAgentVersion(agentId: string, versionId: string): Promise<void> {
    await transaction(async (conn) => {
      await conn.execute("UPDATE agent_versions SET status = 'published', published_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND agent_id = ?", [versionId, agentId]);
      await conn.execute("UPDATE agents SET published_version_id = ?, latest_version_id = ? WHERE id = ?", [versionId, versionId, agentId]);
    });
  },
  async publishLatestAgentVersion(agentId: string, versionId: string): Promise<void> {
    await agentsRepo.publishAgentVersion(agentId, versionId);
  },
};
