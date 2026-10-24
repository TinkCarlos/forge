import { type FastifyInstance } from "fastify";
import { asRecord, assertNoEnvRefs, assertOutboundUrlStatic, config, encryptSecret, errors, ForgeError } from "@forge/core";
import { discoverMcpTools } from "@forge/capabilities";
import { assertOrgWritable } from "@forge/governance";
import { repos } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  jsonBody,
  admin,
  writeAudit,
  prepareAudit,
  requireBodyString,
} from "../../plugins/http-helpers.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../../plugins/input-schema.js";
import { logSafeError } from "@forge/runtime";
import { isDuplicateKey } from "../../plugins/errors.js";

// P0-03 / U-15: MCP servers, Skills, tool sources, plugins and LLM Providers/Models have no department column, so they
// are platform-wide (org = null) and only a dataScope=all principal may write them, whatever its role permissions.
const PLATFORM_WRITE_MESSAGE = "平台级资源仅数据范围为全部（all）的管理员可修改";

interface PluginInstallPlan {
  plugin: { key: string; version: string; type: string; name: string; manifest: unknown };
  agents: Array<{ key: string; name: string; description: string; version: string; instructions: string; spec: unknown }>;
  skills: Array<{ key: string; name: string; description: string; content: string }>;
  mcp: Array<{ key: string; name: string; url: string; headers: unknown }>;
  providers: Array<{ key: string; name: string; protocol: string; baseUrl: string; apiKey: string; headers: unknown; models: Array<{ key: string; displayName: string; capabilities: unknown }> }>;
}

const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map((raw) => asRecord(raw)) : []);

/** S-29: every value the install uses, read and checked up front (throws 400 before anything is created). */
function planPluginInstall(body: Record<string, unknown>): PluginInstallPlan {
  const resources = asRecord(jsonBody(body, "resources", {}));
  const key = requireBodyString(body, "key");
  const plan: PluginInstallPlan = {
    plugin: { key, version: stringBody(body, "version", "1.0.0"), type: stringBody(body, "type", "mixed"), name: stringBody(body, "name", key), manifest: jsonBody(body, "manifest", {}) },
    agents: list(resources.agents).map((agent) => {
      const agentKey = requireBodyString(agent, "key");
      return { key: agentKey, name: stringBody(agent, "name", agentKey), description: stringBody(agent, "description"), version: stringBody(agent, "version", "1.0.0"), instructions: stringBody(agent, "instructions", "You are a helpful assistant."), spec: jsonBody(agent, "spec", {}) };
    }),
    skills: list(resources.skills).map((skill) => {
      const skillKey = requireBodyString(skill, "key");
      return { key: skillKey, name: stringBody(skill, "name", skillKey), description: stringBody(skill, "description"), content: stringBody(skill, "content") };
    }),
    mcp: list(resources.mcp).map((server) => {
      const serverKey = requireBodyString(server, "key");
      const url = requireBodyString(server, "url");
      const headers = jsonBody(server, "headers", {});
      assertOutboundUrlStatic(url); // Outbound guard (S-46): static check (scheme, IP literals, localhost).
      assertNoEnvRefs({ headers }); // AG (S-61): no `env:` header.
      return { key: serverKey, name: stringBody(server, "name", serverKey), url, headers };
    }),
    providers: list(resources.providers).map((provider) => {
      const providerKey = requireBodyString(provider, "key");
      const baseUrl = requireBodyString(provider, "baseUrl");
      const headers = jsonBody(provider, "headers", {});
      assertOutboundUrlStatic(baseUrl);
      assertNoEnvRefs({ headers, apiKey: provider.apiKey });
      const models = list(provider.models).map((model) => {
        const modelKey = requireBodyString(model, "key");
        return { key: modelKey, displayName: stringBody(model, "displayName", modelKey), capabilities: jsonBody(model, "capabilities", ["text", "tools"]) };
      });
      return { key: providerKey, name: stringBody(provider, "name", providerKey), protocol: stringBody(provider, "protocol", "openai-compatible"), baseUrl, apiKey: stringBody(provider, "apiKey"), headers, models };
    }),
  };
  return plan;
}

export default async function adminPluginRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/api/plugins", async (request) => {
    await admin(request, "package.view");
    return { items: await repos.listPlugins() };
  });

  app.post("/admin/api/plugins/install", { schema: ROUTE_SCHEMAS.pluginInstall, attachValidation: true }, async (request) => {
    const session = await admin(request, "plugin.install");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    assertValidInput(request);
    const body = bodyOf(request);
    // S-29: read and check every field of the whole package first (keys, URLs, env refs, names, JSON fields), so a bad
    // package is a 400 with nothing created and nothing audited.
    const plan = planPluginInstall(body);
    const created: Record<"agents" | "skills" | "mcp" | "providers", string[]> = { agents: [], skills: [], mcp: [], providers: [] };
    try {
      for (const agent of plan.agents) {
        if (await repos.getAgentByKey(agent.key)) continue;
        const agentId = await repos.createAgent({ key: agent.key, name: agent.name, description: agent.description, ownerOrgUnitId: session.principal.orgUnitId, createdBy: session.principal.id });
        created.agents.push(agentId);
        const versionId = await repos.createAgentVersion({ agentId, version: agent.version, instructions: agent.instructions, spec: agent.spec, status: "published", createdBy: session.principal.id });
        await repos.publishAgentVersion(agentId, versionId);
      }
      for (const skill of plan.skills) {
        if (await repos.getSkillByKey(skill.key)) continue;
        created.skills.push(await repos.createSkill({ ...skill, publish: true, createdBy: session.principal.id }));
      }
      for (const server of plan.mcp) {
        if (await repos.getMcpServerByKey(server.key)) continue;
        const mcpId = await repos.createMcpServer({ ...server, createdBy: session.principal.id });
        created.mcp.push(mcpId);
        try {
          const record = await repos.getMcpServer(mcpId);
          if (record) await repos.replaceMcpTools(mcpId, await discoverMcpTools(record));
        } catch {
          // Package install keeps the server for later refresh.
        }
      }
      for (const provider of plan.providers) {
        if (await repos.getProviderByKey(provider.key)) continue;
        const providerId = await repos.createProvider({ key: provider.key, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, apiKeyEncrypted: provider.apiKey ? encryptSecret(provider.apiKey, config.FORGE_MASTER_KEY) : null, headers: provider.headers, createdBy: session.principal.id });
        created.providers.push(providerId);
        for (const model of provider.models) await repos.createModel({ providerId, ...model });
      }
      const pluginId = await repos.createPlugin({ ...plan.plugin, resources: created, createdBy: session.principal.id });
      await writeAudit(session, "plugin.install", "plugin", pluginId, created);
      return { id: pluginId, created };
    } catch (error) {
      // S-29: compensate (remove exactly what this request created), record the failure, then surface the original error.
      let compensated = true;
      try {
        await repos.discardPluginResources(created);
      } catch (cleanupError) {
        compensated = false;
        request.log.error({ err: logSafeError(cleanupError), created }, "plugin install compensation failed");
      }
      const code = error instanceof ForgeError ? error.code : isDuplicateKey(error) ? errors.conflict().code : "internal";
      await writeAudit(session, "plugin.install.failed", "plugin", null, { key: plan.plugin.key, error: code, compensated, rolledBack: created }, { orgUnitId: null }).catch((auditError: unknown) => {
        request.log.error({ err: logSafeError(auditError) }, "plugin.install.failed audit not written");
      });
      throw error;
    }
  });

  app.post("/admin/api/plugins/:id/uninstall", { schema: ROUTE_SCHEMAS.noBody, attachValidation: true }, async (request) => {
    const session = await admin(request, "plugin.uninstall");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    // #68 / I-PLG-04: unknown id -> 404 (no audit). Department scoping waits for an owner-department column.
    const plugin = await repos.getPlugin(param(request, "id"));
    if (!plugin) throw errors.notFound("插件不存在");
    assertValidInput(request);
    // Delete-class audit: the department is taken before the change and passed explicitly, never re-resolved from a
    // row that may be gone. Plugins are platform-level (no department column) -> explicit null.
    // P2: the audit entry is validated before uninstalling (guard failure -> nothing uninstalled).
    const orgUnitId = null;
    const audit = prepareAudit(session, "plugin.uninstall", "plugin", String(plugin.id), undefined, { orgUnitId });
    await repos.uninstallPlugin(String(plugin.id));
    await audit();
    return { ok: true };
  });
}
