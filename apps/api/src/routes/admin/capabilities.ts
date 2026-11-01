import { type FastifyInstance } from "fastify";
import { credentialHeaderInput, credentialHeaderRefsInput, storedHeaderSecretRefs, SKILL_STATUSES, assertNoEnvRefs, assertOutboundUrlStatic, errors, ForgeError } from "@forge/core";
import { discoverMcpTools, parseOpenApi } from "@forge/capabilities";
import { assertOrgWritable, assertSecretReferences } from "@forge/governance";
import { repos } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  jsonObjectBody,
  admin,
  writeAudit,
  configurationWrite,
  configurationResult,
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
        revision: server.revision,
        key: server.key,
        name: server.name,
        url: server.url,
        transport: server.transport,
        status: server.status,
        lastError: server.last_error,
        headerSecretRefs: storedHeaderSecretRefs(server.header_secret_refs_json),
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
    assertNoEnvRefs({ headers: jsonObjectBody(body, "headers", {}) }); // AG (S-61)
    const headerSecretRefs = body.headerSecretRefs === undefined ? undefined : credentialHeaderRefsInput(jsonObjectBody(body, "headerSecretRefs", {}));
    await assertSecretReferences(session.principal, Object.values(headerSecretRefs ?? {}));
    const id = await repos.createMcpServer({
      key,
      name: stringBody(body, "name", key),
      url: requireBodyString(body, "url"),
      headers: credentialHeaderInput(jsonObjectBody(body, "headers", {})),
      headerSecretRefs,
      transport: stringBody(body, "transport", "http"),
      createdBy: session.principal.id,
    }, { actorType: "user", actorId: session.principal.id, action: "mcp.create", resourceType: "mcp_server", resourceId: null, details: { key }, orgUnitId: null });
    let warning: string | null = null;
    try {
      const server = await repos.getMcpServer(id);
      if (server) {
        const tools = await discoverMcpTools(server);
        await repos.updateMcpServer(id, { last_error: null }, { expectedRevision: Number(server.revision), afterWrite: (conn) => repos.replaceMcpTools(id, tools, conn) });
      }
    } catch (error) {
      warning = String(error);
      if (!(error instanceof ForgeError && error.code === "CFG-8503")) {
        try {
          await repos.updateMcpServer(id, { last_error: warning.slice(0, 1000) }, { expectedRevision: 1 });
        } catch (writeError) {
          if (!(writeError instanceof ForgeError && writeError.code === "CFG-8503")) throw writeError;
        }
      }
    }
    return { id, warning };
  });

  app.patch("/admin/api/mcp/:id", { schema: ROUTE_SCHEMAS.mcpPatch, attachValidation: true }, async (request, reply) => {
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
      fields.headers_json = credentialHeaderInput(jsonObjectBody(body, "headers", {}));
      assertNoEnvRefs({ headers: fields.headers_json }); // AG (S-61)
    }
    if (body.headerSecretRefs !== undefined) fields.header_secret_refs_json = credentialHeaderRefsInput(jsonObjectBody(body, "headerSecretRefs", {}));
    await assertSecretReferences(session.principal, Object.values((fields.header_secret_refs_json ?? {}) as Record<string, string>));
    if (body.status !== undefined) fields.status = stringBody(body, "status");
    const revision = await repos.updateMcpServer(String(server.id), fields, configurationWrite(request, session, "mcp.update", "mcp_server", String(server.id), { name: fields.name, url: fields.url, status: fields.status, headerNames: body.headers === undefined ? undefined : Object.keys(fields.headers_json as object) }, null));
    return configurationResult(reply, revision);
  });

  app.post("/admin/api/mcp/:id/refresh", { schema: ROUTE_SCHEMAS.noBody, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "mcp.manage");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    const server = await repos.getMcpServer(param(request, "id"));
    if (!server) throw errors.notFound("MCP 不存在");
    assertValidInput(request);
    const write = configurationWrite(request, session, "mcp.refresh", "mcp_server", String(server.id), undefined, null);
    if (write.expectedRevision !== Number(server.revision)) throw errors.conflict("配置已被修改，请重新打开后刷新工具");
    const tools = await discoverMcpTools(server);
    const revision = await repos.updateMcpServer(String(server.id), { last_error: null, status: "active" }, { ...write, audit: write.audit ? { ...write.audit, details: { tools: tools.length } } : undefined, afterWrite: (conn) => repos.replaceMcpTools(String(server.id), tools, conn) });
    return { ...configurationResult(reply, revision), tools };
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

  app.get("/admin/api/skills/:id", async (request, reply) => {
    const session = await admin(request, "skill.view");
    const skill = await repos.getSkill(param(request, "id"));
    if (!skill) throw errors.notFound("Skill 不存在");
    configurationResult(reply, Number(skill.revision));
    return { ...skill, versions: await repos.listSkillVersions(String(skill.id)) };
  });

  app.patch("/admin/api/skills/:id", { schema: ROUTE_SCHEMAS.skillPatch, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "skill.manage");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    const skill = await repos.getSkill(param(request, "id"));
    if (!skill) throw errors.notFound("Skill 不存在");
    assertValidInput(request);
    const body = bodyOf(request);
    const status = enumBody(body, "status", SKILL_STATUSES);
    const revision = await repos.updateSkill(skill.id as string, {
      name: body.name !== undefined ? stringBody(body, "name") : undefined,
      description: body.description !== undefined ? stringBody(body, "description") : undefined,
      status,
    }, configurationWrite(request, session, "skill.update", "skill", String(skill.id), { name: body.name, ...(status !== undefined ? { status } : {}) }, null));
    return configurationResult(reply, revision);
  });

  app.post("/admin/api/skills/:id/versions", { schema: ROUTE_SCHEMAS.skillVersionCreate, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "skill.manage");
    await assertOrgWritable(session.principal, null, PLATFORM_WRITE_MESSAGE); // P0-03 / U-15: platform-wide resource (no department column)
    const skill = await repos.getSkill(param(request, "id"));
    if (!skill) throw errors.notFound("Skill 不存在");
    assertValidInput(request);
    const body = bodyOf(request);
    const version = requireBodyString(body, "version");
    const content = stringBody(body, "content", "");
    const write = configurationWrite(request, session, "skill.version.create", "skill_version", null, { skillId: skill.id }, null);
    const versionId = await repos.createSkillVersion(
      String(skill.id),
      version,
      content,
      body.publish !== false,
      write,
    );
    return { ...configurationResult(reply, Number(write.expectedRevision) + 1), versionId };
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
        headerSecretRefs: storedHeaderSecretRefs(source.header_secret_refs_json),
        tools: (await repos.listToolsBySourceKey(String(source.key))).map(tool => Object.fromEntries(Object.entries(tool).filter(([key]) => !["headers_json", "header_secret_refs_json"].includes(key)))),
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
    const spec = jsonObjectBody(body, "spec", null);
    if (!spec || typeof spec !== "object") throw errors.invalid("spec 必须是 OpenAPI JSON");
    const parsed = parseOpenApi(spec as Record<string, unknown>, stringBody(body, "baseUrl"));
    if (!parsed.baseUrl) throw errors.invalid("缺少 baseUrl 或 servers[0].url");
    assertOutboundUrlStatic(parsed.baseUrl);
    assertNoEnvRefs({ headers: jsonObjectBody(body, "headers", {}) }); // AG (S-61)
    const headerSecretRefs = body.headerSecretRefs === undefined ? undefined : credentialHeaderRefsInput(jsonObjectBody(body, "headerSecretRefs", {}));
    await assertSecretReferences(session.principal, Object.values(headerSecretRefs ?? {}));
    const sourceId = await repos.createToolSource({
      key,
      name: stringBody(body, "name", key),
      baseUrl: parsed.baseUrl,
      headers: credentialHeaderInput(jsonObjectBody(body, "headers", {})),
      headerSecretRefs,
      spec,
      createdBy: session.principal.id,
    }, { actorType: "user", actorId: session.principal.id, action: "tool_source.import", resourceType: "tool_source", resourceId: null, details: { key, tools: parsed.tools.length }, orgUnitId: null });
    await repos.replaceTools(sourceId, parsed.tools);
    return { id: sourceId, tools: parsed.tools.length };
  });
}
