import { ulidWithPrefix } from "@forge/core";
import { execute, isRetryableWrite, json, one, query, transaction } from "./db.js";
import type { AgentRow, AgentVersionRow, ApprovalRow, ClaimedRun, MessageRow, ModelRow, ProviderRow, RunRow, RunStepRow, ToolCallRow, UserRow } from "./types.js";
import { identityRepo } from "./repositories/identity.js";

export * from "./db.js";
export * from "./types.js";

export const repos = {
  ...identityRepo,

  // API apps / keys
  async listApiApps(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM api_apps ORDER BY created_at DESC");
  },
  async getApiApp(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM api_apps WHERE id = ?", [id]);
  },
  async createApiApp(input: {
    key: string;
    name: string;
    description?: string;
    ownerOrgUnitId?: string | null;
    scopes: string[];
    webhookUrl?: string | null;
    webhookSecretEncrypted?: string | null;
    rateLimitPerMinute?: number;
    dailyQuota?: number;
    createdBy?: string | null;
  }): Promise<string> {
    const id = ulidWithPrefix("app");
    await execute(
      `INSERT INTO api_apps (id, \`key\`, name, description, owner_org_unit_id, scopes_json, webhook_url, webhook_secret_encrypted, rate_limit_per_minute, daily_quota, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.key,
        input.name,
        input.description ?? "",
        input.ownerOrgUnitId ?? null,
        json(input.scopes),
        input.webhookUrl ?? null,
        input.webhookSecretEncrypted ?? null,
        input.rateLimitPerMinute ?? 60,
        input.dailyQuota ?? 1000,
        input.createdBy ?? null,
      ],
    );
    return id;
  },
  async updateApiApp(id: string, fields: Record<string, unknown>): Promise<void> {
    const allowed = ["name", "description", "status", "scopes_json", "webhook_url", "webhook_secret_encrypted", "rate_limit_per_minute", "daily_quota"];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      sets.push(`\`${key}\` = ?`);
      params.push(key.endsWith("_json") ? json(value) : value);
    }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE api_apps SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async createApiKey(input: { appId: string; name: string; prefix: string; keyHash: string; scopes: string[]; expiresAt?: Date | null }): Promise<string> {
    const id = ulidWithPrefix("key");
    await execute(
      "INSERT INTO api_keys (id, app_id, name, prefix, key_hash, scopes_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, input.appId, input.name, input.prefix, input.keyHash, json(input.scopes), input.expiresAt ?? null],
    );
    return id;
  },
  async listApiKeys(appId: string): Promise<Record<string, unknown>[]> {
    return query("SELECT id, app_id, name, prefix, scopes_json, status, expires_at, last_used_at, created_at FROM api_keys WHERE app_id = ? ORDER BY created_at DESC", [appId]);
  },
  async findApiKeyByPrefix(prefix: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM api_keys WHERE prefix = ? AND status = 'active'", [prefix]);
  },
  async touchApiKey(id: string): Promise<void> {
    await execute("UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [id]);
  },
  async countAppRunsToday(appId: string): Promise<number> {
    const row = await one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM runs WHERE app_id = ? AND created_at >= CURRENT_DATE()",
      [appId],
    );
    return Number(row?.count ?? 0);
  },
  async getIdempotency(scope: string, key: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?", [scope, key]);
  },
  async deleteIdempotency(id: string): Promise<void> {
    await execute("DELETE FROM idempotency_keys WHERE id = ?", [id]);
  },
  async reserveIdempotency(input: { scope: string; key: string; requestHash: string }): Promise<string> {
    const id = ulidWithPrefix("idm");
    await execute(
      "INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status_code, expires_at) VALUES (?, ?, ?, ?, 0, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 24 HOUR))",
      [id, input.scope, input.key, input.requestHash],
    );
    return id;
  },
  async completeIdempotency(id: string, input: { statusCode: number; response: unknown; runId?: string | null }): Promise<void> {
    await execute(
      "UPDATE idempotency_keys SET status_code = ?, response_json = ?, run_id = ?, expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 24 HOUR) WHERE id = ?",
      [input.statusCode, json(input.response), input.runId ?? null, id],
    );
  },
  async enqueueWebhook(input: { appId: string; eventId: string; eventType: string; payload: unknown }): Promise<string | null> {
    const existing = await one<{ id: string }>("SELECT id FROM webhook_deliveries WHERE app_id = ? AND event_id = ?", [input.appId, input.eventId]);
    if (existing) return existing.id;
    const id = ulidWithPrefix("dlv");
    try {
      await execute(
        "INSERT INTO webhook_deliveries (id, app_id, event_id, event_type, payload_json, next_attempt_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))",
        [id, input.appId, input.eventId, input.eventType, json(input.payload)],
      );
      return id;
    } catch (error) {
      if ((error as { errno?: number }).errno !== 1062) throw error;
      const raced = await one<{ id: string }>("SELECT id FROM webhook_deliveries WHERE app_id = ? AND event_id = ?", [input.appId, input.eventId]);
      return raced?.id ?? null;
    }
  },
  async dueWebhookDeliveries(limit = 20): Promise<Record<string, unknown>[]> {
    return query(
      "SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= UTC_TIMESTAMP(3) ORDER BY next_attempt_at LIMIT ?",
      [Math.min(Math.max(limit, 1), 50)],
    );
  },
  async claimWebhookDelivery(id: string, attempts: number): Promise<boolean> {
    const result = await execute(
      "UPDATE webhook_deliveries SET attempts = attempts + 1, next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 60 SECOND) WHERE id = ? AND status = 'pending' AND attempts = ? AND next_attempt_at <= UTC_TIMESTAMP(3)",
      [id, attempts],
    );
    return result.affectedRows === 1;
  },
  async finishWebhookDelivery(id: string, input: { status: "delivered" | "failed"; responseStatus?: number | null; errorMessage?: string | null }): Promise<void> {
    await execute(
      "UPDATE webhook_deliveries SET status = ?, response_status = ?, error_message = ?, delivered_at = IF(? = 'delivered', UTC_TIMESTAMP(3), delivered_at) WHERE id = ?",
      [input.status, input.responseStatus ?? null, input.errorMessage ?? null, input.status, id],
    );
  },
  async scheduleWebhookRetry(id: string, delayMs: number, responseStatus: number | null, errorMessage: string | null): Promise<void> {
    const seconds = Math.max(1, Math.ceil(delayMs / 1000));
    await execute(
      `UPDATE webhook_deliveries SET status = 'pending', response_status = ?, error_message = ?, next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${seconds} SECOND) WHERE id = ?`,
      [responseStatus, errorMessage, id],
    );
  },
  async getWebhookDelivery(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM webhook_deliveries WHERE id = ?", [id]);
  },
  async listWebhookDeliveries(appId: string): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM webhook_deliveries WHERE app_id = ? ORDER BY created_at DESC LIMIT 50", [appId]);
  },
  async replayWebhookDelivery(id: string): Promise<boolean> {
    const result = await execute(
      "UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = UTC_TIMESTAMP(3), error_message = NULL, delivered_at = NULL WHERE id = ?",
      [id],
    );
    return result.affectedRows === 1;
  },

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
    await repos.updateAgent(input.agentId, { latest_version_id: id });
    return id;
  },
  async publishAgentVersion(agentId: string, versionId: string): Promise<void> {
    await transaction(async (conn) => {
      await conn.execute("UPDATE agent_versions SET status = 'published', published_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND agent_id = ?", [versionId, agentId]);
      await conn.execute("UPDATE agents SET published_version_id = ?, latest_version_id = ? WHERE id = ?", [versionId, versionId, agentId]);
    });
  },
  async publishLatestAgentVersion(agentId: string, versionId: string): Promise<void> {
    await repos.publishAgentVersion(agentId, versionId);
  },

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

  // Runs / messages / tools / approvals / events
  async getThread(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM threads WHERE id = ?", [id]);
  },
  async createThread(input: { agentId: string; orgUnitId: string | null; subjectType: string; subjectId: string; title?: string }): Promise<string> {
    const id = ulidWithPrefix("thr");
    await execute(
      "INSERT INTO threads (id, agent_id, org_unit_id, subject_type, subject_id, title) VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.agentId, input.orgUnitId, input.subjectType, input.subjectId, input.title ?? ""],
    );
    return id;
  },
  async createRun(input: {
    threadId: string;
    agentId: string;
    agentVersionId: string;
    appId?: string | null;
    orgUnitId?: string | null;
    subjectType: string;
    subjectId: string;
    triggerType?: string;
    triggerRef?: string | null;
    input: unknown;
    status?: string;
    claimedBy?: string | null;
    leaseSeconds?: number | null;
  }): Promise<string> {
    const id = ulidWithPrefix("run");
    const leaseSeconds = input.leaseSeconds == null ? null : Math.max(1, Math.floor(input.leaseSeconds));
    await execute(
      `INSERT INTO runs (id, thread_id, agent_id, agent_version_id, app_id, org_unit_id, subject_type, subject_id, trigger_type, trigger_ref, input_json, status, claimed_by, lease_expires_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, IF(? IS NULL, NULL, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${leaseSeconds ?? 0} SECOND)), IF(? IS NULL, NULL, UTC_TIMESTAMP(3)))`,
      [id, input.threadId, input.agentId, input.agentVersionId, input.appId ?? null, input.orgUnitId ?? null, input.subjectType, input.subjectId, input.triggerType ?? "manual", input.triggerRef ?? null, json(input.input), input.status ?? "queued", input.claimedBy ?? null, leaseSeconds, leaseSeconds],
    );
    return id;
  },
  async getRun(id: string): Promise<RunRow | null> {
    return one<RunRow>("SELECT * FROM runs WHERE id = ?", [id]);
  },
  async listRuns(filter: { orgIds?: string[] | null; subjectType?: string; subjectId?: string; appId?: string; status?: string; limit?: number }): Promise<RunRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.orgIds && filter.orgIds.length === 0) return [];
    if (filter.orgIds && filter.orgIds.length > 0) {
      where.push(`org_unit_id IN (${filter.orgIds.map(() => "?").join(",")})`);
      params.push(...filter.orgIds);
    }
    if (filter.subjectType) { where.push("subject_type = ?"); params.push(filter.subjectType); }
    if (filter.subjectId) { where.push("subject_id = ?"); params.push(filter.subjectId); }
    if (filter.appId) { where.push("app_id = ?"); params.push(filter.appId); }
    if (filter.status) { where.push("status = ?"); params.push(filter.status); }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    params.push(limit);
    return query<RunRow>(`SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`, params);
  },
  async claimNextRun(workerId: string, leaseSeconds: number): Promise<ClaimedRun | null> {
    const seconds = Math.max(1, Math.floor(leaseSeconds));
    return transaction(async (conn) => {
      const [rows] = await conn.query(
        `SELECT id, status FROM runs
         WHERE status = 'queued'
            OR (status = 'running' AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < UTC_TIMESTAMP(3)))
         ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      const candidate = (rows as Array<{ id: string; status: string }>)[0];
      if (!candidate) return null;
      const [result] = await conn.execute(
        `UPDATE runs
         SET status = 'running',
             claimed_by = ?,
             lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${seconds} SECOND),
             heartbeat_at = UTC_TIMESTAMP(3),
             started_at = COALESCE(started_at, UTC_TIMESTAMP(3))
         WHERE id = ?
           AND (
             status = 'queued'
             OR (status = 'running' AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < UTC_TIMESTAMP(3)))
           )`,
        [workerId, candidate.id],
      );
      if ((result as { affectedRows: number }).affectedRows !== 1) return null;
      const [fresh] = await conn.query("SELECT * FROM runs WHERE id = ?", [candidate.id]);
      const run = (fresh as RunRow[])[0];
      if (!run) return null;
      return { run, previousStatus: candidate.status };
    });
  },
  async claimRun(runId: string, workerId: string, leaseSeconds: number, allowWaiting: boolean): Promise<ClaimedRun | null> {
    const seconds = Math.max(1, Math.floor(leaseSeconds));
    const waitingFlag = allowWaiting ? 1 : 0;
    return transaction(async (conn) => {
      const [rows] = await conn.query("SELECT status FROM runs WHERE id = ? FOR UPDATE", [runId]);
      const current = (rows as Array<{ status: string }>)[0];
      if (!current) return null;
      const [result] = await conn.execute(
        `UPDATE runs
         SET status = 'running',
             claimed_by = ?,
             lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${seconds} SECOND),
             heartbeat_at = UTC_TIMESTAMP(3),
             started_at = COALESCE(started_at, UTC_TIMESTAMP(3))
         WHERE id = ?
           AND (
             status = 'queued'
             OR (status = 'waiting_approval' AND ? = 1)
             OR (status = 'running' AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < UTC_TIMESTAMP(3)))
           )`,
        [workerId, runId, waitingFlag],
      );
      if ((result as { affectedRows: number }).affectedRows !== 1) return null;
      const [fresh] = await conn.query("SELECT * FROM runs WHERE id = ?", [runId]);
      const run = (fresh as RunRow[])[0];
      if (!run) return null;
      return { run, previousStatus: current.status };
    });
  },
  async heartbeatRun(id: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const seconds = Math.max(1, Math.floor(leaseSeconds));
    const result = await execute(
      `UPDATE runs
       SET heartbeat_at = UTC_TIMESTAMP(3), lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${seconds} SECOND)
       WHERE id = ? AND claimed_by = ? AND status = 'running'`,
      [id, workerId],
    );
    return result.affectedRows === 1;
  },
  async releaseRunLease(id: string, workerId: string): Promise<void> {
    await execute("UPDATE runs SET claimed_by = NULL, lease_expires_at = NULL, heartbeat_at = NULL WHERE id = ? AND claimed_by = ?", [id, workerId]);
  },
  async expireRunLease(id: string, claimedBy = "expired-worker"): Promise<void> {
    await execute(
      "UPDATE runs SET status = 'running', claimed_by = ?, lease_expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 60 SECOND), heartbeat_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 60 SECOND) WHERE id = ?",
      [claimedBy, id],
    );
  },
  async updateRun(id: string, fields: {
    status?: string; output?: unknown; usage?: unknown; costUsd?: number; errorCode?: string | null; errorMessage?: string | null; cancelRequested?: boolean; startedAt?: Date | null; completedAt?: Date | null;
  }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.status) { sets.push("status = ?"); params.push(fields.status); }
    if (fields.output !== undefined) { sets.push("output_json = ?"); params.push(json(fields.output)); }
    if (fields.usage !== undefined) { sets.push("usage_json = ?"); params.push(json(fields.usage)); }
    if (fields.costUsd !== undefined) { sets.push("cost_usd = ?"); params.push(fields.costUsd); }
    if (fields.errorCode !== undefined) { sets.push("error_code = ?"); params.push(fields.errorCode); }
    if (fields.errorMessage !== undefined) { sets.push("error_message = ?"); params.push(fields.errorMessage); }
    if (fields.cancelRequested !== undefined) { sets.push("cancel_requested = ?"); params.push(fields.cancelRequested ? 1 : 0); }
    if (fields.startedAt !== undefined) { sets.push("started_at = ?"); params.push(fields.startedAt); }
    if (fields.completedAt !== undefined) { sets.push("completed_at = ?"); params.push(fields.completedAt); }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async requestCancel(id: string): Promise<void> {
    await execute("UPDATE runs SET cancel_requested = 1 WHERE id = ?", [id]);
  },
  async addMessage(input: { threadId: string; runId: string; seq: number; role: string; content: unknown }): Promise<string> {
    const id = ulidWithPrefix("msg");
    await execute(
      "INSERT INTO messages (id, thread_id, run_id, seq, role, content_json) VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.threadId, input.runId, input.seq, input.role, json(input.content)],
    );
    return id;
  },
  async listMessages(runId: string): Promise<MessageRow[]> {
    return query<MessageRow>("SELECT * FROM messages WHERE run_id = ? ORDER BY seq", [runId]);
  },
  async listThreadMessages(threadId: string): Promise<MessageRow[]> {
    return query<MessageRow>("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, seq", [threadId]);
  },
  async nextMessageSeq(runId: string): Promise<number> {
    const row = await one<{ maxSeq: number | null }>("SELECT MAX(seq) AS maxSeq FROM messages WHERE run_id = ?", [runId]);
    return Number(row?.maxSeq ?? 0) + 1;
  },
  async addToolCall(input: { runId: string; toolKey: string; args: unknown; risk: string; status?: string; approvalId?: string | null; idempotencyKey?: string | null; attempt?: number }): Promise<string> {
    if (input.idempotencyKey) {
      const existing = await one<{ id: string }>("SELECT id FROM tool_calls WHERE run_id = ? AND idempotency_key = ?", [input.runId, input.idempotencyKey]);
      if (existing) return existing.id;
    }
    const id = ulidWithPrefix("tcl");
    try {
      await execute(
        "INSERT INTO tool_calls (id, run_id, tool_key, args_json, risk_level, status, approval_id, idempotency_key, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, input.runId, input.toolKey, json(input.args), input.risk, input.status ?? "running", input.approvalId ?? null, input.idempotencyKey ?? null, input.attempt ?? 1],
      );
      return id;
    } catch (error) {
      const errno = (error as { errno?: number }).errno;
      if (errno === 1062 && input.idempotencyKey) {
        const existing = await one<{ id: string }>("SELECT id FROM tool_calls WHERE run_id = ? AND idempotency_key = ?", [input.runId, input.idempotencyKey]);
        if (existing) return existing.id;
      }
      throw error;
    }
  },
  async updateToolCall(id: string, fields: { status?: string; result?: unknown; resultText?: string | null; errorCode?: string | null; approvalId?: string | null; attempt?: number }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.status) { sets.push("status = ?"); params.push(fields.status); }
    if (fields.result !== undefined) { sets.push("result_json = ?"); params.push(json(fields.result)); }
    if (fields.resultText !== undefined) { sets.push("result_text = ?"); params.push(fields.resultText); }
    if (fields.errorCode !== undefined) { sets.push("error_code = ?"); params.push(fields.errorCode); }
    if (fields.approvalId !== undefined) { sets.push("approval_id = ?"); params.push(fields.approvalId); }
    if (fields.attempt !== undefined) { sets.push("attempt = ?"); params.push(fields.attempt); }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE tool_calls SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async getToolCall(id: string): Promise<ToolCallRow | null> {
    return one<ToolCallRow>("SELECT * FROM tool_calls WHERE id = ?", [id]);
  },
  async listToolCalls(runId: string): Promise<ToolCallRow[]> {
    return query<ToolCallRow>("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY created_at", [runId]);
  },
  async addApproval(input: { runId: string; toolCallId: string; risk: string; timeoutSeconds: number }): Promise<string> {
    const id = ulidWithPrefix("apr");
    await execute(
      "INSERT INTO approvals (id, run_id, tool_call_id, risk_level, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND))",
      [id, input.runId, input.toolCallId, input.risk, input.timeoutSeconds],
    );
    await execute("UPDATE tool_calls SET status = 'pending_approval', approval_id = ? WHERE id = ?", [id, input.toolCallId]);
    return id;
  },
  async getApproval(id: string): Promise<ApprovalRow | null> {
    return one<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", [id]);
  },
  async listApprovals(status?: string): Promise<Array<ApprovalRow & { agent_name?: string }>> {
    const where = status ? "WHERE a.status = ?" : "";
    const params = status ? [status] : [];
    return query<Array<ApprovalRow & { agent_name?: string }>[number]>(
      `SELECT a.*, ag.name AS agent_name FROM approvals a JOIN runs r ON r.id = a.run_id JOIN agents ag ON ag.id = r.agent_id ${where} ORDER BY a.created_at DESC LIMIT 100`,
      params,
    );
  },
  async decideApproval(id: string, decision: "approved" | "rejected", decidedBy: string, comment: string): Promise<boolean> {
    const result = await execute(
      "UPDATE approvals SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP(3), comment = ? WHERE id = ? AND status = 'pending'",
      [decision, decidedBy, comment, id],
    );
    return result.affectedRows === 1;
  },
  async listPendingApprovedCalls(runId: string): Promise<Array<ToolCallRow & { approval_status: string }>> {
    return query(
      `SELECT tc.*, a.status AS approval_status FROM tool_calls tc JOIN approvals a ON a.id = tc.approval_id
       WHERE tc.run_id = ? AND tc.status = 'pending_approval' AND a.status IN ('approved','rejected') ORDER BY tc.created_at`,
      [runId],
    );
  },
  async listExpiredToolCalls(runId: string): Promise<Array<ToolCallRow & { approval_status: string }>> {
    return query(
      `SELECT tc.*, a.status AS approval_status FROM tool_calls tc JOIN approvals a ON a.id = tc.approval_id
       WHERE tc.run_id = ? AND tc.status = 'pending_approval' AND a.status = 'expired' ORDER BY tc.created_at`,
      [runId],
    );
  },
  async listOpenToolCalls(runId: string): Promise<Array<ToolCallRow & { approval_status: string | null }>> {
    return query(
      `SELECT tc.*, a.status AS approval_status FROM tool_calls tc LEFT JOIN approvals a ON a.id = tc.approval_id
       WHERE tc.run_id = ? AND tc.status IN ('pending','pending_approval','running') ORDER BY tc.created_at`,
      [runId],
    );
  },
  async timeoutApprovals(runId: string): Promise<number> {
    const result = await execute("UPDATE approvals SET status = 'expired', decided_at = CURRENT_TIMESTAMP(3) WHERE run_id = ? AND status = 'pending' AND expires_at < CURRENT_TIMESTAMP(3)", [runId]);
    return result.affectedRows;
  },
  async addRunStep(input: { runId: string; type: string; status?: string; summary?: unknown; toolCallId?: string | null }): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await transaction(async (conn) => {
          const [rows] = await conn.execute("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM run_steps WHERE run_id = ? FOR UPDATE", [input.runId]);
          const seq = Number((rows as Array<{ maxSeq: number }>)[0]?.maxSeq ?? 0) + 1;
          const id = ulidWithPrefix("stp");
          const status = input.status ?? "running";
          await conn.execute(
            "INSERT INTO run_steps (id, run_id, seq, type, status, tool_call_id, summary_json, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, IF(? IN ('succeeded','failed'), UTC_TIMESTAMP(3), NULL))",
            [id, input.runId, seq, input.type, status, input.toolCallId ?? null, json(input.summary ?? null), status],
          );
          return id;
        });
      } catch (error) {
        if (!isRetryableWrite(error) || attempt === 4) throw error;
      }
    }
    throw new Error("failed to allocate run step");
  },
  async finishRunStep(id: string, fields: { status: string; errorCode?: string | null; summary?: unknown; inputTokens?: number; outputTokens?: number; costUsd?: number }): Promise<void> {
    await execute(
      "UPDATE run_steps SET status = ?, error_code = ?, summary_json = COALESCE(?, summary_json), input_tokens = ?, output_tokens = ?, cost_usd = ?, ended_at = UTC_TIMESTAMP(3) WHERE id = ?",
      [fields.status, fields.errorCode ?? null, fields.summary === undefined ? null : json(fields.summary), fields.inputTokens ?? 0, fields.outputTokens ?? 0, fields.costUsd ?? 0, id],
    );
  },
  async listRunSteps(runId: string): Promise<RunStepRow[]> {
    return query<RunStepRow>("SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq", [runId]);
  },
  async failRunningSteps(runId: string, type: string, errorCode: string): Promise<number> {
    const result = await execute(
      "UPDATE run_steps SET status = 'failed', error_code = ?, ended_at = UTC_TIMESTAMP(3) WHERE run_id = ? AND type = ? AND status = 'running'",
      [errorCode, runId, type],
    );
    return result.affectedRows;
  },
  async addEvent(runId: string, type: string, data: unknown): Promise<number> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await transaction(async (conn) => {
          const [rows] = await conn.execute("SELECT COALESCE(MAX(seq),0) AS maxSeq FROM run_events WHERE run_id = ? FOR UPDATE", [runId]);
          const maxSeq = Number((rows as Array<{ maxSeq: number }>)[0]?.maxSeq ?? 0);
          const seq = maxSeq + 1;
          await conn.execute("INSERT INTO run_events (run_id, seq, type, data_json) VALUES (?, ?, ?, ?)", [runId, seq, type, json(data)]);
          return seq;
        });
      } catch (error) {
        if (!isRetryableWrite(error) || attempt === 7) throw error;
      }
    }
    throw new Error("failed to allocate run event");
  },
  async listEvents(runId: string, afterSeq = 0): Promise<Array<{ run_id: string; seq: number; type: string; data_json: unknown; created_at: Date }>> {
    return query("SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq", [runId, afterSeq]);
  },

  // Schedules
  async listSchedules(): Promise<Record<string, unknown>[]> {
    return query("SELECT s.*, a.name AS agent_name FROM schedules s JOIN agents a ON a.id = s.agent_id ORDER BY s.created_at DESC");
  },
  async getSchedule(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM schedules WHERE id = ?", [id]);
  },
  async createSchedule(input: { key: string; name: string; agentId: string; orgUnitId: string | null; subjectType: string; subjectId: string; cron: string; timezone: string; input: unknown; status?: string; nextRunAt?: Date | null; createdBy?: string | null }): Promise<string> {
    const id = ulidWithPrefix("sch");
    await execute(
      "INSERT INTO schedules (id, `key`, name, agent_id, org_unit_id, subject_type, subject_id, cron, timezone, input_json, status, next_run_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, input.key, input.name, input.agentId, input.orgUnitId, input.subjectType, input.subjectId, input.cron, input.timezone, json(input.input), input.status ?? "disabled", input.nextRunAt ?? null, input.createdBy ?? null],
    );
    return id;
  },
  async updateSchedule(id: string, fields: Record<string, unknown>): Promise<void> {
    const allowed = ["name", "cron", "timezone", "input_json", "status", "next_run_at", "last_run_id"];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      sets.push(`\`${key}\` = ?`);
      params.push(key.endsWith("_json") ? json(value) : value);
    }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async dueSchedules(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM schedules WHERE status = 'active' AND (next_run_at IS NULL OR next_run_at <= CURRENT_TIMESTAMP(3)) ORDER BY next_run_at LIMIT 20");
  },
  async markScheduleRun(id: string, nextRunAt: Date, lastRunId: string): Promise<void> {
    await execute("UPDATE schedules SET next_run_at = ?, last_run_id = ? WHERE id = ?", [nextRunAt, lastRunId, id]);
  },

  // Plugins / audit / settings / SSO mappings
  async createPlugin(input: { key: string; version: string; type: string; name: string; manifest: unknown; resources: unknown; createdBy?: string | null }): Promise<string> {
    const id = ulidWithPrefix("pkg");
    await execute(
      "INSERT INTO plugins (id, `key`, version, type, name, manifest_json, resources_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE manifest_json = VALUES(manifest_json), resources_json = VALUES(resources_json), status = 'active'",
      [id, input.key, input.version, input.type, input.name, json(input.manifest), json(input.resources), input.createdBy ?? null],
    );
    return id;
  },
  async listPlugins(): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM plugins ORDER BY created_at DESC");
  },
  async uninstallPlugin(id: string): Promise<void> {
    await execute("UPDATE plugins SET status = 'uninstalled' WHERE id = ?", [id]);
  },
  async audit(input: { actorType: string; actorId?: string | null; action: string; resourceType: string; resourceId?: string | null; details?: unknown }): Promise<void> {
    await execute(
      "INSERT INTO audit_logs (id, actor_type, actor_id, action, resource_type, resource_id, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [ulidWithPrefix("aud"), input.actorType, input.actorId ?? null, input.action, input.resourceType, input.resourceId ?? null, json(input.details ?? {})],
    );
  },
  async listAudit(limit = 100): Promise<Record<string, unknown>[]> {
    return query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?", [Math.min(limit, 500)]);
  },
  async stats(): Promise<Record<string, unknown>> {
    const runs = await query<{ status: string; count: number }>("SELECT status, COUNT(*) AS count FROM runs GROUP BY status");
    const agents = await one<{ count: number }>("SELECT COUNT(*) AS count FROM agents WHERE deleted_at IS NULL");
    const approvals = await one<{ count: number }>("SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'");
    const today = await one<{ count: number }>("SELECT COUNT(*) AS count FROM runs WHERE created_at >= CURRENT_DATE()");
    return {
      runsByStatus: Object.fromEntries(runs.map((row) => [row.status, Number(row.count)])),
      agents: Number(agents?.count ?? 0),
      pendingApprovals: Number(approvals?.count ?? 0),
      runsToday: Number(today?.count ?? 0),
    };
  },
  async getSetting(key: string): Promise<unknown | null> {
    const row = await one<{ value_json: unknown }>("SELECT value_json FROM settings WHERE `key` = ?", [key]);
    return row?.value_json ?? null;
  },
  async setSetting(key: string, value: unknown): Promise<void> {
    await execute("INSERT INTO settings (`key`, value_json) VALUES (?, ?) ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)", [key, json(value)]);
  },
};
