import { initializeCredentialBindings, resourceCredentialChanges } from "../credential-bindings.js";
import { updateConfiguration, type ConfigurationWrite, type ConfigurationAudit } from "../configuration-revision.js";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { errors, jsonShapeMatches, storedJsonObject, ulidWithPrefix } from "@forge/core";
import { execute, json, one, query, transaction } from "../db.js";
import { auditRepo } from "./audit.js";
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
  async publishSkillVersion(skillId: string, versionId: string, options: ConfigurationWrite): Promise<void> {
    await updateConfiguration("skills", skillId, { published_version_id: versionId, latest_version_id: versionId }, { ...options, beforeWrite: async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>("SELECT id FROM skill_versions WHERE id = ? AND skill_id = ?", [versionId, skillId]);
      if (!rows[0]) throw errors.notFound("版本不存在");
      await conn.execute("UPDATE skill_versions SET status = 'published', published_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND skill_id = ?", [versionId, skillId]);
      if (options.beforeWrite) await options.beforeWrite(conn);
    } });
  },
  async createSkillVersion(skillId: string, version: string, content: string, publish: boolean, options: ConfigurationWrite): Promise<string> {
    const versionId = ulidWithPrefix("skv");
    await updateConfiguration("skills", skillId, { latest_version_id: versionId, ...(publish ? { published_version_id: versionId } : {}) }, {
      ...options, audit: options.audit ? { ...options.audit, resourceId: versionId } : undefined,
      beforeWrite: async (conn) => {
        await conn.execute("INSERT INTO skill_versions (id, skill_id, version, status, content_md, published_at) VALUES (?, ?, ?, ?, ?, ?)",
          [versionId, skillId, version, publish ? "published" : "draft", content, publish ? new Date() : null]);
        if (options.beforeWrite) await options.beforeWrite(conn);
      },
    });
    return versionId;
  },
  async updateSkill(id: string, fields: { name?: string; description?: string; status?: string }, options: ConfigurationWrite): Promise<number> {
    const values = { ...(fields.name ? { name: fields.name } : {}), ...(fields.description !== undefined ? { description: fields.description } : {}), ...(fields.status ? { status: fields.status } : {}) };
    return updateConfiguration("skills", id, values, options);
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
  async createMcpServer(input: { key: string; name: string; url: string; headers?: unknown; headerSecretRefs?: unknown; transport?: string; createdBy?: string | null }, audit?: ConfigurationAudit): Promise<string> {
    const id = ulidWithPrefix("mcp");
    await transaction(async conn => {
      await conn.execute("INSERT INTO mcp_servers (id, `key`, name, transport, url, headers_json, created_by) VALUES (?, ?, ?, ?, ?, '{}', ?)", [id, input.key, input.name, input.transport ?? "http", input.url, input.createdBy ?? null]);
      await initializeCredentialBindings(conn, { type: "mcp_server", id, name: input.name, orgUnitId: null, createdBy: input.createdBy ?? null }, { headers: input.headers ?? {}, headerSecretRefs: input.headerSecretRefs }, audit);
      if (audit) await auditRepo.audit({ ...audit, resourceId: id }, conn);
    });
    return id;
  },
  async updateMcpServer(id: string, fields: Record<string, unknown>, options: ConfigurationWrite): Promise<number> {
    const allowed = ["name", "url", "status", "last_error"];
    const values = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.includes(key)));
    return updateConfiguration("mcp_servers", id, async conn => ({ ...values, ...await resourceCredentialChanges("mcp_server", id, fields, conn, options.audit) }), options);
  },
  /**
   * r5 resync: upsert by (server_id, name) keeping id / created_at (history references tools by key), re-enable a tool
   * that is back upstream, and disable (never delete) tools no longer listed upstream. readOnly defaults to false.
   */
  async replaceMcpTools(serverId: string, tools: Array<{ name: string; description?: string; inputSchema?: unknown; risk?: string; readOnly?: boolean }>, connection?: PoolConnection): Promise<void> {
    const write = async (conn: PoolConnection) => {
      for (const tool of tools) {
        await conn.execute(
          `INSERT INTO mcp_tools (id, server_id, name, description, input_schema_json, risk_level, read_only, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1) AS up
           ON DUPLICATE KEY UPDATE description = up.description, input_schema_json = up.input_schema_json, risk_level = up.risk_level, read_only = up.read_only, enabled = 1, revision = revision + 1`,
          [ulidWithPrefix("mct"), serverId, tool.name, tool.description ?? "", json(tool.inputSchema ?? {}), tool.risk ?? "medium", tool.readOnly === true ? 1 : 0],
        );
      }
      const names = tools.map((tool) => tool.name);
      await conn.execute(
        `UPDATE mcp_tools SET enabled = 0, revision = revision + 1 WHERE server_id = ? AND enabled = 1${names.length ? ` AND name NOT IN (${names.map(() => "?").join(", ")})` : ""}`,
        [serverId, ...names],
      );
    };
    if (connection) await write(connection);
    else await transaction(write);
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
  async createToolSource(input: { key: string; name: string; baseUrl: string; headers?: unknown; headerSecretRefs?: unknown; spec: unknown; createdBy?: string | null }, audit?: ConfigurationAudit): Promise<string> {
    const id = ulidWithPrefix("tls");
    await transaction(async conn => {
      await conn.execute("INSERT INTO tool_sources (id, `key`, name, base_url, headers_json, spec_json, created_by) VALUES (?, ?, ?, ?, '{}', ?, ?)", [id, input.key, input.name, input.baseUrl, json(input.spec), input.createdBy ?? null]);
      await initializeCredentialBindings(conn, { type: "tool_source", id, name: input.name, orgUnitId: null, createdBy: input.createdBy ?? null }, { headers: input.headers ?? {}, headerSecretRefs: input.headerSecretRefs }, audit);
      if (audit) await auditRepo.audit({ ...audit, resourceId: id }, conn);
    });
    return id;
  },
  /** r5 resync, same rules as replaceMcpTools: upsert by (source_id, name) keeping id, disable (never delete) removed tools. */
  async replaceTools(sourceId: string, tools: Array<{ name: string; operationId: string; method: string; path: string; description?: string; inputSchema?: unknown; risk?: string; readOnly?: boolean }>, connection?: PoolConnection): Promise<void> {
    const write = async (conn: PoolConnection) => {
      for (const tool of tools) {
        await conn.execute(
          `INSERT INTO tools (id, source_id, name, operation_id, method, path, description, input_schema_json, risk_level, read_only, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) AS up
           ON DUPLICATE KEY UPDATE operation_id = up.operation_id, method = up.method, path = up.path, description = up.description,
             input_schema_json = up.input_schema_json, risk_level = up.risk_level, read_only = up.read_only, enabled = 1, revision = revision + 1`,
          [ulidWithPrefix("tol"), sourceId, tool.name, tool.operationId, tool.method.toUpperCase(), tool.path, tool.description ?? "", json(tool.inputSchema ?? {}), tool.risk ?? "low", tool.readOnly === true ? 1 : 0],
        );
      }
      const names = tools.map((tool) => tool.name);
      await conn.execute(
        `UPDATE tools SET enabled = 0, revision = revision + 1 WHERE source_id = ? AND enabled = 1${names.length ? ` AND name NOT IN (${names.map(() => "?").join(", ")})` : ""}`,
        [sourceId, ...names],
      );
    };
    if (connection) await write(connection);
    else await transaction(write);
  },
  async listToolsBySourceKey(sourceKey: string): Promise<Record<string, unknown>[]> {
    return query(
      "SELECT t.*, s.`key` AS source_key, s.base_url, s.headers_json, s.header_secret_refs_json FROM tools t JOIN tool_sources s ON s.id = t.source_id WHERE s.`key` = ? AND s.status = 'active' AND t.enabled = 1 ORDER BY t.name",
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
  async createProvider(input: { key: string; name: string; protocol: string; baseUrl: string; apiKey?: string | null; secretId?: string | null; apiKeyEncrypted?: string | null; headers?: unknown; headerSecretRefs?: unknown; timeoutMs?: number; createdBy?: string | null }, audit?: ConfigurationAudit): Promise<string> {
    const id = ulidWithPrefix("prv");
    await transaction(async conn => {
      await conn.execute("INSERT INTO llm_providers (id, `key`, name, protocol, base_url, headers_json, timeout_ms, created_by) VALUES (?, ?, ?, ?, ?, '{}', ?, ?)", [id, input.key, input.name, input.protocol, input.baseUrl, input.timeoutMs ?? 120000, input.createdBy ?? null]);
      await initializeCredentialBindings(conn, { type: "llm_provider", id, name: input.name, orgUnitId: null, createdBy: input.createdBy ?? null }, { value: input.apiKey, secretId: input.secretId, legacyEncrypted: input.apiKeyEncrypted, headers: input.headers ?? {}, headerSecretRefs: input.headerSecretRefs }, audit);
      if (audit) await auditRepo.audit({ ...audit, resourceId: id }, conn);
    });
    return id;
  },
  async updateProvider(id: string, fields: Record<string, unknown>, options: ConfigurationWrite): Promise<number> {
    const allowed = ["name", "protocol", "base_url", "timeout_ms", "status"];
    const values = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.includes(key)));
    return updateConfiguration("llm_providers", id, async conn => ({ ...values, ...await resourceCredentialChanges("llm_provider", id, fields, conn, options.audit) }), options);
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
  async updateModel(id: string, fields: Record<string, unknown>, options: ConfigurationWrite): Promise<number> {
    const allowed = ["display_name","capabilities_json","context_window","max_output_tokens","input_price_per_mtok","output_price_per_mtok","status"];
    const values = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.includes(key)).map(([key, value]) => [key, key.endsWith("_json") ? json(value) : value]));
    return updateConfiguration("llm_models", id, values, options);
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
        const merged = mergeResourceIds(storedJsonObject(existing.resources_json, { table: "plugins", column: "resources_json", id: existing.id }), input.resources);
        await conn.execute("UPDATE plugins SET manifest_json = ?, resources_json = ?, status = 'active', revision = revision + 1 WHERE id = ?", [json(input.manifest), json(merged), existing.id]);
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
  /**
   * Item A: a plugin whose stored manifest_json is not a JSON object is unusable: nothing it installed is loaded. Returns
   * the ids of the resources such plugins recorded (resources_json), per kind. One warning per broken plugin (id only).
   */
  async unusablePluginResourceIds(): Promise<Record<"agents" | "skills" | "mcp" | "providers", Set<string>>> {
    const out = { agents: new Set<string>(), skills: new Set<string>(), mcp: new Set<string>(), providers: new Set<string>() };
    for (const row of await query<{ id: string; manifest_json: unknown; resources_json: unknown }>("SELECT id, manifest_json, resources_json FROM plugins")) {
      if (jsonShapeMatches(row.manifest_json, "object")) continue;
      console.warn(JSON.stringify({ level: "warn", msg: "plugin manifest is not a JSON object, plugin not loaded", table: "plugins", column: "manifest_json", id: row.id }));
      const resources = storedJsonObject(row.resources_json, { table: "plugins", column: "resources_json", id: row.id });
      for (const kind of Object.keys(out) as Array<keyof typeof out>) {
        const ids = resources[kind];
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") out[kind].add(id);
      }
    }
    return out;
  },
  async uninstallPlugin(id: string, options: ConfigurationWrite): Promise<number> {
    return updateConfiguration("plugins", id, { status: "uninstalled" }, options);
  },
  /**
   * S-29 compensation: hard-deletes the resources a failed plugin install created in this request (ids only, never
   * pre-existing rows), in one transaction. Skill versions, MCP tools and models go by ON DELETE CASCADE; agent
   * versions are removed explicitly (RESTRICT) after clearing the agent's version pointers.
   */
  async discardPluginResources(created: { agents?: string[]; skills?: string[]; mcp?: string[]; providers?: string[] }): Promise<void> {
    const inList = (ids: string[]) => ids.map(() => "?").join(", ");
    await transaction(async (conn) => {
      for (const [table, ids] of [["mcp_servers", created.mcp ?? []], ["llm_providers", created.providers ?? []]] as const) {
        if (ids.length) await conn.query(`SELECT id FROM ${table} WHERE id IN (${inList(ids)}) ORDER BY id FOR UPDATE`, ids);
      }
      const agents = created.agents ?? [];
      if (agents.length) {
        await conn.execute(`UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE id IN (${inList(agents)})`, agents);
        await conn.execute(`DELETE FROM agent_versions WHERE agent_id IN (${inList(agents)})`, agents);
        await conn.execute(`DELETE FROM agents WHERE id IN (${inList(agents)})`, agents);
      }
      for (const [table, ids] of [["skills", created.skills ?? []], ["mcp_servers", created.mcp ?? []], ["llm_providers", created.providers ?? []]] as const) {
        if (ids.length && table !== "skills") {
          const [refs] = await conn.query<RowDataPacket[]>(`SELECT id FROM resource_references WHERE from_type = ? AND from_id IN (${inList(ids)})`, [table === "mcp_servers" ? "mcp_server" : "llm_provider", ...ids]);
          if (refs.length) await conn.execute(`DELETE FROM resource_references WHERE id IN (${inList(refs.map(ref => String(ref.id)))})`, refs.map(ref => String(ref.id)));
        }
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
