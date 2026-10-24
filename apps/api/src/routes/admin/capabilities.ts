import { type FastifyInstance } from "fastify";
import { SKILL_STATUSES, assertNoEnvRefs, assertOutboundUrlStatic, errors } from "@forge/core";
import { discoverMcpTools, parseOpenApi } from "@forge/capabilities";
import { assertOrgWritable, maskArgsDeep } from "@forge/governance";
import { repos } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  jsonBody,
  admin,
  writeAudit,
  requireBodyString,
  enumBody,
} from "../../plugins/http-helpers.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../../plugins/input-schema.js";

// P0-03 / U-15: MCP servers, Skills, tool sources, plugins and LLM Providers/Models have no department column, so they
// are platform-wide (org = null) and only a dataScope=all principal may write them, whatever its role permissions.
const PLATFORM_WRITE_MESSAGE = "平台级资源仅数据范围为全部（all）的管理员可修改";

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

  app.post("/admin/api/mcp", { schema: ROUTE_SCHEMAS.mcpCreate, attachValidation: true }, async (request) => {
    const session = await admin(request, "mcp.manage");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    assertValidInput(request);
    const body = bodyOf(request);
    const key = requireBodyString(body, "key");
    if (await repos.getMcpServerByKey(key)) throw errors.conflict("MCP key 已存在");
    assertOutboundUrlStatic(requireBodyString(body, "url"));
    assertNoEnvRefs({ headers: jsonBody(body, "headers", {}) }); // AG (S-61)
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

  app.patch("/admin/api/mcp/:id", { schema: ROUTE_SCHEMAS.mcpPatch, attachValidation: true }, async (request) => {
    const session = await admin(request, "mcp.manage");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    const server = await repos.getMcpServer(param(request, "id"));
    if (!server) throw errors.notFound("MCP 不存在");
    assertValidInput(request);
    const body = bodyOf(request);
    const fields: Record<string, unknown> = {};
    if (body.name !== undefined) fields.name = stringBody(body, "name");
    if (body.url !== undefined) {
      fields.url = stringBody(body, "url");
      assertOutboundUrlStatic(String(fields.url));
    }
    if (body.headers !== undefined) {
      fields.headers_json = jsonBody(body, "headers", {});
      assertNoEnvRefs({ headers: fields.headers_json }); // AG (S-61)
    }
    if (body.status !== undefined) fields.status = stringBody(body, "status");
    await repos.updateMcpServer(String(server.id), fields);
    await writeAudit(session, "mcp.update", "mcp_server", String(server.id), maskArgsDeep(fields));
    return { ok: true };
  });

  app.post("/admin/api/mcp/:id/refresh", async (request) => {
    const session = await admin(request, "mcp.manage");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
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

  app.post("/admin/api/skills", { schema: ROUTE_SCHEMAS.skillCreate, attachValidation: true }, async (request) => {
    const session = await admin(request, "skill.manage");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    assertValidInput(request);
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

  app.patch("/admin/api/skills/:id", { schema: ROUTE_SCHEMAS.skillPatch, attachValidation: true }, async (request) => {
    const session = await admin(request, "skill.manage");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    const skill = await repos.getSkill(param(request, "id"));
    if (!skill) throw errors.notFound("Skill 不存在");
    assertValidInput(request);
    const body = bodyOf(request);
    const status = enumBody(body, "status", SKILL_STATUSES);
    await repos.updateSkill(skill.id as string, {
      name: body.name !== undefined ? stringBody(body, "name") : undefined,
      description: body.description !== undefined ? stringBody(body, "description") : undefined,
      status,
    });
    await writeAudit(session, "skill.update", "skill", String(skill.id), { name: body.name, ...(status !== undefined ? { status } : {}) });
    return { ok: true };
  });

  app.post("/admin/api/skills/:id/versions", { schema: ROUTE_SCHEMAS.skillVersionCreate, attachValidation: true }, async (request) => {
    const session = await admin(request, "skill.manage");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    const skill = await repos.getSkill(param(request, "id"));
    if (!skill) throw errors.notFound("Skill 不存在");
    assertValidInput(request);
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

  app.post("/admin/api/tool-sources/import", { schema: ROUTE_SCHEMAS.toolSourceImport, attachValidation: true }, async (request) => {
    const session = await admin(request, "tool.manage");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    assertValidInput(request);
    const body = bodyOf(request);
    const key = requireBodyString(body, "key");
    if (await repos.getToolSourceByKey(key)) throw errors.conflict("工具源 key 已存在");
    const spec = jsonBody(body, "spec", null);
    if (!spec || typeof spec !== "object") throw errors.invalid("spec 必须是 OpenAPI JSON");
    const parsed = parseOpenApi(spec as Record<string, unknown>, stringBody(body, "baseUrl"));
    if (!parsed.baseUrl) throw errors.invalid("缺少 baseUrl 或 servers[0].url");
    assertOutboundUrlStatic(parsed.baseUrl);
    assertNoEnvRefs({ headers: jsonBody(body, "headers", {}) }); // AG (S-61)
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
