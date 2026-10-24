import { ulidWithPrefix } from "@forge/core";
import { execute, json, one, parseJsonValue, query, transaction } from "../db.js";
import type { ModelRow, ProviderRow } from "../types.js";

export const capabilitiesRepo = {
  // Skills
  async listSkills(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM skills WHERE deleted_at IS NULL ORDER BY created_at DESC");
  },
  async getSkillByKey(key: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM skills WHERE `key` = ? AND deleted_at IS NULL", [key]);
  },
  async getSkill(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM skills WHERE id = ? AND deleted_at IS NULL", [id]);
  },
  async listSkillVersions(skillId: string): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY created_at DESC", [skillId]);
  },
  async getSkillVersion(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM skill_versions WHERE id = ?", [id]);
  },
  async createSkill(input: { key: string; name: string; description?: string; content: string; version?: string; publish?: boolean; createdBy?: string | null }): Promise<string> {
    const skillId = ulidWithPrefix("skl");
    const versionId = ulidWithPrefix("skv");
    await transaction(async (conn) => {
      await conn.execute("INSERT INTO skills (id, `key`, name, description, created_by) VALUES (?, ?, ?, ?, ?)", [skillId, input.key, input.name, input.description ?? "", input.createdBy ?? null]);
      await conn.execute(
        "INSERT INTO skill_versions (id, skill_id, version, status, content_md, published_at) VALUES (?, ?, ?, ?, ?, ?)",
        [versionId, skillId, input.version ?? "1.0.0", input.publish ? "published" : "draft", input.content, input.publish ? new Date() : null],
      );
      await conn.execute("UPDATE skills SET latest_version_id = ?, published_version_id = ? WHERE id = ?", [versionId, input.publish ? versionId : null, skillId]);
    });
    return skillId;
  },
  async publishSkillVersion(skillId: string, versionId: string): Promise<void> {
    await transaction(async (conn) => {
      await conn.execute("UPDATE skill_versions SET status = 'published', published_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND skill_id = ?", [versionId, skillId]);
      await conn.execute("UPDATE skills SET published_version_id = ?, latest_version_id = ? WHERE id = ?", [versionId, versionId, skillId]);
    });
  },
  async createSkillVersion(skillId: string, version: string, content: string, publish = true): Promise<string> {
    const versionId = ulidWithPrefix("skv");
    await transaction(async (conn) => {
      await conn.execute(
        "INSERT INTO skill_versions (id, skill_id, version, status, content_md, published_at) VALUES (?, ?, ?, ?, ?, ?)",
        [versionId, skillId, version, publish ? "published" : "draft", content, publish ? new Date() : null],
      );
      if (publish) await conn.execute("UPDATE skills SET published_version_id = ?, latest_version_id = ? WHERE id = ?", [versionId, versionId, skillId]);
      else await conn.execute("UPDATE skills SET latest_version_id = ? WHERE id = ?", [versionId, skillId]);
    });
    return versionId;
  },
  async updateSkill(id: string, fields: { name?: string; description?: string; status?: string }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.name) { sets.push("name = ?"); params.push(fields.name); }
    if (fields.description !== undefined) { sets.push("description = ?"); params.push(fields.description); }
    if (fields.status) { sets.push("status = ?"); params.push(fields.status); }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE skills SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async getPublishedSkillContent(key: string): Promise<string | null> {
    const row = await one<{ content_md: string }>(
      `SELECT sv.content_md FROM skills s JOIN skill_versions sv ON sv.id = s.published_version_id WHERE s.\`key\` = ? AND s.status = 'active'`,
      [key],
    );
    return row?.content_md ?? null;
  },

  // MCP
  async listMcpServers(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM mcp_servers WHERE deleted_at IS NULL ORDER BY created_at DESC");
  },
  async getMcpServer(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM mcp_servers WHERE id = ? AND deleted_at IS NULL", [id]);
  },
  async getMcpServerByKey(key: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM mcp_servers WHERE `key` = ? AND deleted_at IS NULL", [key]);
  },
  async createMcpServer(input: { key: string; name: string; url: string; headers?: unknown; transport?: string; createdBy?: string | null }): Promise<string> {
    const id = ulidWithPrefix("mcp");
    await execute(
      "INSERT INTO mcp_servers (id, `key`, name, transport, url, headers_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, input.key, input.name, input.transport ?? "http", input.url, json(input.headers ?? {}), input.createdBy ?? null],
    );
    return id;
  },
  async updateMcpServer(id: string, fields: Record<string, unknown>): Promise<void> {
    const allowed = ["name", "url", "headers_json", "status", "last_error"];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      sets.push(`\`${key}\` = ?`);
      params.push(key.endsWith("_json") ? json(value) : value);
    }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async replaceMcpTools(serverId: string, tools: Array<{ name: string; description?: string; inputSchema?: unknown; risk?: string }>): Promise<void> {
    await transaction(async (conn) => {
      await conn.execute("DELETE FROM mcp_tools WHERE server_id = ?", [serverId]);
      for (const tool of tools) {
        await conn.execute(
          "INSERT INTO mcp_tools (id, server_id, name, description, input_schema_json, risk_level) VALUES (?, ?, ?, ?, ?, ?)",
          [ulidWithPrefix("mct"), serverId, tool.name, tool.description ?? "", json(tool.inputSchema ?? {}), tool.risk ?? "medium"],
        );
      }
    });
  },
  async listMcpTools(serverId: string): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM mcp_tools WHERE server_id = ? ORDER BY name", [serverId]);
  },
  async listMcpToolsByServerKey(serverKey: string): Promise<Record<string, unknown>[]> {
    return query(
      "SELECT t.*, s.`key` AS server_key FROM mcp_tools t JOIN mcp_servers s ON s.id = t.server_id WHERE s.`key` = ? AND s.status = 'active' AND t.enabled = 1 ORDER BY t.name",
      [serverKey],
    );
  },

  // OpenAPI tools
  async listToolSources(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM tool_sources ORDER BY created_at DESC");
  },
  async getToolSourceByKey(key: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM tool_sources WHERE `key` = ?", [key]);
  },
  async createToolSource(input: { key: string; name: string; baseUrl: string; headers?: unknown; spec: unknown; createdBy?: string | null }): Promise<string> {
    const id = ulidWithPrefix("tls");
    await execute(
      "INSERT INTO tool_sources (id, `key`, name, base_url, headers_json, spec_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, input.key, input.name, input.baseUrl, json(input.headers ?? {}), json(input.spec), input.createdBy ?? null],
    );
    return id;
  },
  async replaceTools(sourceId: string, tools: Array<{ name: string; operationId: string; method: string; path: string; description?: string; inputSchema?: unknown; risk?: string }>): Promise<void> {
    await transaction(async (conn) => {
      await conn.execute("DELETE FROM tools WHERE source_id = ?", [sourceId]);
      for (const tool of tools) {
        await conn.execute(
          "INSERT INTO tools (id, source_id, name, operation_id, method, path, description, input_schema_json, risk_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [ulidWithPrefix("tol"), sourceId, tool.name, tool.operationId, tool.method.toUpperCase(), tool.path, tool.description ?? "", json(tool.inputSchema ?? {}), tool.risk ?? "low"],
        );
      }
    });
  },
  async listToolsBySourceKey(sourceKey: string): Promise<Record<string, unknown>[]> {
    return query(
      "SELECT t.*, s.`key` AS source_key, s.base_url, s.headers_json FROM tools t JOIN tool_sources s ON s.id = t.source_id WHERE s.`key` = ? AND s.status = 'active' AND t.enabled = 1 ORDER BY t.name",
      [sourceKey],
    );
  },

  // Providers/models/routes
  async listProviders(): Promise<ProviderRow[]> {
    return query<ProviderRow>("SELECT * FROM llm_providers ORDER BY created_at DESC");
  },
  async getProviderByKey(key: string): Promise<ProviderRow | null> {
    return one<ProviderRow>("SELECT * FROM llm_providers WHERE `key` = ? AND status = 'active'", [key]);
  },
  async getProviderById(id: string): Promise<ProviderRow | null> {
    return one<ProviderRow>("SELECT * FROM llm_providers WHERE id = ? AND status = 'active'", [id]);
  },
  async createProvider(input: { key: string; name: string; protocol: string; baseUrl: string; apiKeyEncrypted?: string | null; headers?: unknown; timeoutMs?: number; createdBy?: string | null }): Promise<string> {
    const id = ulidWithPrefix("prv");
    await execute(
      "INSERT INTO llm_providers (id, `key`, name, protocol, base_url, api_key_encrypted, headers_json, timeout_ms, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, input.key, input.name, input.protocol, input.baseUrl, input.apiKeyEncrypted ?? null, json(input.headers ?? {}), input.timeoutMs ?? 120000, input.createdBy ?? null],
    );
    return id;
  },
  async updateProvider(id: string, fields: Record<string, unknown>): Promise<void> {
    const allowed = ["name", "protocol", "base_url", "api_key_encrypted", "headers_json", "timeout_ms", "status"];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      sets.push(`\`${key}\` = ?`);
      params.push(key.endsWith("_json") ? json(value) : value);
    }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE llm_providers SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async listModels(providerId?: string): Promise<ModelRow[]> {
    if (providerId) return query<ModelRow>("SELECT * FROM llm_models WHERE provider_id = ? ORDER BY created_at DESC", [providerId]);
    return query<ModelRow>("SELECT * FROM llm_models ORDER BY created_at DESC");
  },
  async getModel(providerKey: string, modelKey: string): Promise<ModelRow | null> {
    return one<ModelRow>(
      "SELECT m.* FROM llm_models m JOIN llm_providers p ON p.id = m.provider_id WHERE p.`key` = ? AND m.`key` = ? AND m.status = 'active' AND p.status = 'active'",
      [providerKey, modelKey],
    );
  },
  async getModelById(id: string): Promise<ModelRow | null> {
    return one<ModelRow>("SELECT * FROM llm_models WHERE id = ? AND status = 'active'", [id]);
  },
  async createModel(input: { providerId: string; key: string; displayName: string; capabilities?: unknown; contextWindow?: number; maxOutputTokens?: number; inputPrice?: number; outputPrice?: number }): Promise<string> {
    const id = ulidWithPrefix("mdl");
    await execute(
      "INSERT INTO llm_models (id, provider_id, `key`, display_name, capabilities_json, context_window, max_output_tokens, input_price_per_mtok, output_price_per_mtok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, input.providerId, input.key, input.displayName, json(input.capabilities ?? ["text", "tools"]), input.contextWindow ?? 32768, input.maxOutputTokens ?? 4096, input.inputPrice ?? 0, input.outputPrice ?? 0],
    );
    return id;
  },
  async updateModel(id: string, fields: Record<string, unknown>): Promise<void> {
    const allowed = ["display_name", "capabilities_json", "context_window", "max_output_tokens", "input_price_per_mtok", "output_price_per_mtok", "status"];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      sets.push(`\`${key}\` = ?`);
      params.push(key.endsWith("_json") ? json(value) : value);
    }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE llm_models SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async listRoutes(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM llm_routes ORDER BY created_at DESC");
  },
  async getRoute(key: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM llm_routes WHERE `key` = ? AND status = 'active'", [key]);
  },
  async createRoute(input: { key: string; name: string; candidates: unknown }): Promise<string> {
    const id = ulidWithPrefix("rte");
    await execute("INSERT INTO llm_routes (id, `key`, name, candidates_json) VALUES (?, ?, ?, ?)", [id, input.key, input.name, json(input.candidates)]);
    return id;
  },

  // Plugins
  /**
   * Installs a plugin record. P2: a reinstall (same key + version, e.g. after an uninstall) reuses the original row and
   * its `pkg_` id (returned, so audit entries point at a real row); the resource references are merged (the original
   * ids are kept, ids created by this install are added) and the record is active again.
   */
  async createPlugin(input: { key: string; version: string; type: string; name: string; manifest: unknown; resources: unknown; createdBy?: string | null }): Promise<string> {
    return transaction(async (conn) => {
      const [rows] = await conn.query("SELECT id, resources_json FROM plugins WHERE `key` = ? AND version = ? FOR UPDATE", [input.key, input.version]);
      const existing = (rows as Array<{ id: string; resources_json: unknown }>)[0];
      if (existing) {
        const merged = mergeResourceIds(parseJsonValue(existing.resources_json, {}), input.resources);
        await conn.execute("UPDATE plugins SET manifest_json = ?, resources_json = ?, status = 'active' WHERE id = ?", [json(input.manifest), json(merged), existing.id]);
        return existing.id;
      }
      const id = ulidWithPrefix("pkg");
      await conn.execute(
        "INSERT INTO plugins (id, `key`, version, type, name, manifest_json, resources_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, input.key, input.version, input.type, input.name, json(input.manifest), json(input.resources), input.createdBy ?? null],
      );
      return id;
    });
  },
  async listPlugins(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM plugins ORDER BY created_at DESC");
  },
  async getPlugin(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM plugins WHERE id = ?", [id]);
  },
  async uninstallPlugin(id: string): Promise<void> {
    await execute("UPDATE plugins SET status = 'uninstalled' WHERE id = ?", [id]);
  },
  /**
   * S-29 compensation: hard-deletes the resources a failed plugin install created in this request (ids only, never
   * pre-existing rows), in one transaction. Skill versions, MCP tools and models go by ON DELETE CASCADE; agent
   * versions are removed explicitly (RESTRICT) after clearing the agent's version pointers.
   */
  async discardPluginResources(created: { agents?: string[]; skills?: string[]; mcp?: string[]; providers?: string[] }): Promise<void> {
    const inList = (ids: string[]) => ids.map(() => "?").join(", ");
    await transaction(async (conn) => {
      const agents = created.agents ?? [];
      if (agents.length) {
        await conn.execute(`UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE id IN (${inList(agents)})`, agents);
        await conn.execute(`DELETE FROM agent_versions WHERE agent_id IN (${inList(agents)})`, agents);
        await conn.execute(`DELETE FROM agents WHERE id IN (${inList(agents)})`, agents);
      }
      for (const [table, ids] of [["skills", created.skills ?? []], ["mcp_servers", created.mcp ?? []], ["llm_providers", created.providers ?? []]] as const) {
        if (ids.length) await conn.execute(`DELETE FROM ${table} WHERE id IN (${inList(ids)})`, ids);
      }
    });
  },
};

/** Union of two `{ kind: id[] }` resource maps, original ids first, no duplicates. */
function mergeResourceIds(original: unknown, added: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const source of [original, added]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [kind, ids] of Object.entries(source as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue;
      const list = (out[kind] ??= []);
      for (const id of ids) if (typeof id === "string" && !list.includes(id)) list.push(id);
    }
  }
  return out;
}
