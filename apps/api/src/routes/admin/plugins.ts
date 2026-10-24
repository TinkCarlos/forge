import { type FastifyInstance } from "fastify";
import { asRecord, assertNoEnvRefs, assertOutboundUrlStatic, config, encryptSecret, errors } from "@forge/core";
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
  requireBodyString,
} from "../../plugins/http-helpers.js";

// P0-03 / U-15: MCP servers, Skills, tool sources, plugins and LLM Providers/Models have no department column, so they
// are platform-wide (org = null) and only a dataScope=all principal may write them, whatever its role permissions.
const PLATFORM_WRITE_MESSAGE = "平台级资源仅数据范围为全部（all）的管理员可修改";

export default async function adminPluginRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/api/plugins", async (request) => {
    await admin(request, "package.view");
    return { items: await repos.listPlugins() };
  });

  app.post("/admin/api/plugins/install", async (request) => {
    const session = await admin(request, "plugin.install");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    const body = bodyOf(request);
    const resources = asRecord(body.resources);
    // Outbound guard (S-46): check every URL in the package before creating anything (static: scheme, IP literals, localhost).
    for (const raw of Array.isArray(resources.mcp) ? resources.mcp : []) assertOutboundUrlStatic(requireBodyString(asRecord(raw), "url"));
    for (const raw of Array.isArray(resources.providers) ? resources.providers : []) assertOutboundUrlStatic(requireBodyString(asRecord(raw), "baseUrl"));
    // AG (S-61): no `env:` header / apiKey anywhere in the package, checked before anything is created.
    for (const raw of Array.isArray(resources.mcp) ? resources.mcp : []) assertNoEnvRefs({ headers: jsonBody(asRecord(raw), "headers", {}) });
    for (const raw of Array.isArray(resources.providers) ? resources.providers : []) {
      const provider = asRecord(raw);
      assertNoEnvRefs({ headers: jsonBody(provider, "headers", {}), apiKey: provider.apiKey });
    }
    const created: Record<string, string[]> = { agents: [], skills: [], mcp: [], providers: [] };
    if (Array.isArray(resources.agents)) {
      for (const raw of resources.agents) {
        const agent = asRecord(raw);
        const key = requireBodyString(agent, "key");
        if (await repos.getAgentByKey(key)) continue;
        const agentId = await repos.createAgent({ key, name: stringBody(agent, "name", key), description: stringBody(agent, "description"), ownerOrgUnitId: session.principal.orgUnitId, createdBy: session.principal.id });
        const versionId = await repos.createAgentVersion({ agentId, version: stringBody(agent, "version", "1.0.0"), instructions: stringBody(agent, "instructions", "You are a helpful assistant."), spec: jsonBody(agent, "spec", {}), status: "published", createdBy: session.principal.id });
        await repos.publishAgentVersion(agentId, versionId);
        created.agents!.push(agentId);
      }
    }
    if (Array.isArray(resources.skills)) {
      for (const raw of resources.skills) {
        const skill = asRecord(raw);
        const key = requireBodyString(skill, "key");
        if (await repos.getSkillByKey(key)) continue;
        const skillId = await repos.createSkill({ key, name: stringBody(skill, "name", key), description: stringBody(skill, "description"), content: stringBody(skill, "content"), publish: true, createdBy: session.principal.id });
        created.skills!.push(skillId);
      }
    }
    if (Array.isArray(resources.mcp)) {
      for (const raw of resources.mcp) {
        const server = asRecord(raw);
        const key = requireBodyString(server, "key");
        if (await repos.getMcpServerByKey(key)) continue;
        const mcpId = await repos.createMcpServer({ key, name: stringBody(server, "name", key), url: requireBodyString(server, "url"), headers: jsonBody(server, "headers", {}), createdBy: session.principal.id });
        try {
          const record = await repos.getMcpServer(mcpId);
          if (record) await repos.replaceMcpTools(mcpId, await discoverMcpTools(record));
        } catch {
          // Package install keeps the server for later refresh.
        }
        created.mcp!.push(mcpId);
      }
    }
    if (Array.isArray(resources.providers)) {
      for (const raw of resources.providers) {
        const provider = asRecord(raw);
        const key = requireBodyString(provider, "key");
        if (await repos.getProviderByKey(key)) continue;
        const apiKey = stringBody(provider, "apiKey");
        const providerId = await repos.createProvider({ key, name: stringBody(provider, "name", key), protocol: stringBody(provider, "protocol", "openai-compatible"), baseUrl: requireBodyString(provider, "baseUrl"), apiKeyEncrypted: apiKey ? encryptSecret(apiKey, config.FORGE_MASTER_KEY) : null, headers: jsonBody(provider, "headers", {}), createdBy: session.principal.id });
        if (Array.isArray(provider.models)) {
          for (const rawModel of provider.models) {
            const model = asRecord(rawModel);
            await repos.createModel({ providerId, key: requireBodyString(model, "key"), displayName: stringBody(model, "displayName", stringBody(model, "key")), capabilities: jsonBody(model, "capabilities", ["text", "tools"]) });
          }
        }
        created.providers!.push(providerId);
      }
    }
    const pluginId = await repos.createPlugin({
      key: requireBodyString(body, "key"),
      version: stringBody(body, "version", "1.0.0"),
      type: stringBody(body, "type", "mixed"),
      name: stringBody(body, "name", stringBody(body, "key")),
      manifest: body.manifest ?? {},
      resources: created,
      createdBy: session.principal.id,
    });
    await writeAudit(session, "plugin.install", "plugin", pluginId, created);
    return { id: pluginId, created };
  });

  app.post("/admin/api/plugins/:id/uninstall", async (request) => {
    const session = await admin(request, "plugin.uninstall");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    // #68 / I-PLG-04: unknown id -> 404 (no audit). Department scoping waits for an owner-department column.
    const plugin = await repos.getPlugin(param(request, "id"));
    if (!plugin) throw errors.notFound("插件不存在");
    await repos.uninstallPlugin(String(plugin.id));
    await writeAudit(session, "plugin.uninstall", "plugin", param(request, "id"));
    return { ok: true };
  });
}
