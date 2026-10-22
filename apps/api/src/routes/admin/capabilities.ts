import { type FastifyInstance } from "fastify";
import { errors } from "@forge/core";
import { discoverMcpTools, parseOpenApi } from "@forge/capabilities";
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

export default async function adminCapabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/api/mcp", async (request) => {
    await admin(request, "mcp.view");
    const servers = await repos.listMcpServers();
    const items = await Promise.all(
      servers.map(async (server) => ({
        id: server.id,
        key: server.key,
        name: server.name,
        url: server.url,
        transport: server.transport,
        status: server.status,
        lastError: server.last_error,
        tools: await repos.listMcpTools(String(server.id)),
      })),
    );
    return { items };
  });

  app.post("/admin/api/mcp", async (request) => {
    const session = await admin(request, "mcp.manage");
    const body = bodyOf(request);
    const key = requireBodyString(body, "key");
    if (await repos.getMcpServerByKey(key)) throw errors.conflict("MCP key 已存在");
    const id = await repos.createMcpServer({
      key,
      name: stringBody(body, "name", key),
      url: requireBodyString(body, "url"),
      headers: jsonBody(body, "headers", {}),
      transport: stringBody(body, "transport", "http"),
      createdBy: session.principal.id,
    });
    let warning: string | null = null;
    try {
      const server = await repos.getMcpServer(id);
      if (server) {
        const tools = await discoverMcpTools(server);
        await repos.replaceMcpTools(id, tools);
      }
    } catch (error) {
      warning = String(error);
      await repos.updateMcpServer(id, { last_error: warning.slice(0, 1000) });
    }
    await writeAudit(session, "mcp.create", "mcp_server", id, { key });
    return { id, warning };
  });

  app.patch("/admin/api/mcp/:id", async (request) => {
    const session = await admin(request, "mcp.manage");
    const server = await repos.getMcpServer(param(request, "id"));
    if (!server) throw errors.notFound("MCP 不存在");
    const body = bodyOf(request);
    const fields: Record<string, unknown> = {};
    if (body.name !== undefined) fields.name = stringBody(body, "name");
    if (body.url !== undefined) fields.url = stringBody(body, "url");
    if (body.headers !== undefined) fields.headers_json = jsonBody(body, "headers", {});
    if (body.status !== undefined) fields.status = stringBody(body, "status");
    await repos.updateMcpServer(String(server.id), fields);
    await writeAudit(session, "mcp.update", "mcp_server", String(server.id), fields);
    return { ok: true };
  });

  app.post("/admin/api/mcp/:id/refresh", async (request) => {
    const session = await admin(request, "mcp.manage");
    const server = await repos.getMcpServer(param(request, "id"));
    if (!server) throw errors.notFound("MCP 不存在");
    const tools = await discoverMcpTools(server);
    await repos.replaceMcpTools(String(server.id), tools);
    await repos.updateMcpServer(String(server.id), { last_error: null, status: "active" });
    await writeAudit(session, "mcp.refresh", "mcp_server", String(server.id), { tools: tools.length });
    return { tools };
  });

  app.get("/admin/api/skills", async (request) => {
    await admin(request, "skill.view");
    const skills = await repos.listSkills();
    return { items: skills };
  });

  app.post("/admin/api/skills", async (request) => {
    const session = await admin(request, "skill.manage");
    const body = bodyOf(request);
    const key = requireBodyString(body, "key");
    if (await repos.getSkillByKey(key)) throw errors.conflict("Skill key 已存在");
    const id = await repos.createSkill({
      key,
      name: stringBody(body, "name", key),
      description: stringBody(body, "description"),
      content: stringBody(body, "content", "# Skill\n"),
      version: stringBody(body, "version", "1.0.0"),
      publish: body.publish !== false,
      createdBy: session.principal.id,
    });
    await writeAudit(session, "skill.create", "skill", id, { key });
    return { id };
  });

  app.get("/admin/api/skills/:id", async (request) => {
    const session = await admin(request, "skill.view");
    const skill = await repos.getSkill(param(request, "id"));
    if (!skill) throw errors.notFound("Skill 不存在");
    return { ...skill, versions: await repos.listSkillVersions(String(skill.id)) };
  });

  app.patch("/admin/api/skills/:id", async (request) => {
    const session = await admin(request, "skill.manage");
    const skill = await repos.getSkill(param(request, "id"));
    if (!skill) throw errors.notFound("Skill 不存在");
    const body = bodyOf(request);
    await repos.updateSkill(skill.id as string, {
      name: body.name !== undefined ? stringBody(body, "name") : undefined,
      description: body.description !== undefined ? stringBody(body, "description") : undefined,
      status: body.status !== undefined ? stringBody(body, "status") : undefined,
    });
    await writeAudit(session, "skill.update", "skill", String(skill.id), { name: body.name });
    return { ok: true };
  });

  app.post("/admin/api/skills/:id/versions", async (request) => {
    const session = await admin(request, "skill.manage");
    const skill = await repos.getSkill(param(request, "id"));
    if (!skill) throw errors.notFound("Skill 不存在");
    const body = bodyOf(request);
    const versionId = await repos.createSkillVersion(
      String(skill.id),
      requireBodyString(body, "version"),
      stringBody(body, "content", ""),
      body.publish !== false,
    );
    await writeAudit(session, "skill.version.create", "skill_version", versionId, { skillId: skill.id });
    return { versionId };
  });

  app.get("/admin/api/tool-sources", async (request) => {
    await admin(request, "tool.view");
    const sources = await repos.listToolSources();
    const items = await Promise.all(
      sources.map(async (source) => ({
        id: source.id,
        key: source.key,
        name: source.name,
        baseUrl: source.base_url,
        tools: await repos.listToolsBySourceKey(String(source.key)),
      })),
    );
    return { items };
  });

  app.post("/admin/api/tool-sources/import", async (request) => {
    const session = await admin(request, "tool.manage");
    const body = bodyOf(request);
    const key = requireBodyString(body, "key");
    if (await repos.getToolSourceByKey(key)) throw errors.conflict("工具源 key 已存在");
    const spec = jsonBody(body, "spec", null);
    if (!spec || typeof spec !== "object") throw errors.invalid("spec 必须是 OpenAPI JSON");
    const parsed = parseOpenApi(spec as Record<string, unknown>, stringBody(body, "baseUrl"));
    if (!parsed.baseUrl) throw errors.invalid("缺少 baseUrl 或 servers[0].url");
    const sourceId = await repos.createToolSource({
      key,
      name: stringBody(body, "name", key),
      baseUrl: parsed.baseUrl,
      headers: jsonBody(body, "headers", {}),
      spec,
      createdBy: session.principal.id,
    });
    await repos.replaceTools(sourceId, parsed.tools);
    await writeAudit(session, "tool_source.import", "tool_source", sourceId, { key, tools: parsed.tools.length });
    return { id: sourceId, tools: parsed.tools.length };
  });
}
