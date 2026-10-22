import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { CronExpressionParser } from "cron-parser";
import {
  asRecord,
  config,
  defaultDataScope,
  encryptSecret,
  errors,
  ForgeError,
  hashApiKey,
  hashPassword,
  ROLE_PERMISSIONS,
  type Role,
} from "@forge/core";
import { assertRunAccess, runFilterFor, visibleAgentOrgIds } from "@forge/governance";
import { oidcConfigured } from "@forge/identity";
import { discoverMcpTools, parseOpenApi } from "@forge/capabilities";
import { callModel } from "@forge/models";
import {
  cancelRun,
  createQueuedRun,
  deliverDueWebhooks,
  executeRun,
  startRuntime,
} from "@forge/runtime";
import { parseJsonValue, repos } from "@forge/store";
import {
  reqId,
  bodyOf,
  param,
  stringBody,
  arrayBody,
  jsonBody,
  readSession,
  admin,
  writeAudit,
  agentAccessible,
  presentRun,
  presentAgent,
  requireBodyString,
  streamRun,
  sessionPayload,
} from "./plugins/http-helpers.js";
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import integrationRoutes from "./routes/integration.js";
import openRoutes from "./routes/open.js";

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport: config.NODE_ENV === "development" ? { target: "pino-pretty", options: { translateTime: "SYS:standard" } } : undefined,
  },
  bodyLimit: 2 * 1024 * 1024,
  requestIdHeader: "x-request-id",
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
await app.register(fastifyStatic, {
  root: path.resolve(process.cwd(), "apps/console/public"),
  prefix: "/assets/",
});

// ---------- errors / CSRF ----------

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ForgeError) {
    reply.status(error.httpStatus).send({
      error: {
        code: error.code,
        message: error.message,
        requestId: reqId(request),
        details: error.details ?? null,
        retryable: error.retryable,
      },
    });
    return;
  }
  request.log.error(error);
  reply.status(500).send({
    error: { code: "SYS-9001", message: "内部错误", requestId: reqId(request), retryable: false },
  });
});

app.addHook("preHandler", async (request) => {
  if (request.url.startsWith("/admin/api") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const session = readSession(request);
    if (session && request.headers["x-csrf-token"] !== session.csrfToken) {
      throw errors.forbidden("CSRF Token 缺失或无效");
    }
  }
});

// ---------- health / auth ----------

await app.register(healthRoutes);

await app.register(authRoutes);

// ---------- dashboard / agents ----------

app.get("/admin/api/dashboard", async (request) => {
  const session = await admin(request, "agent.view");
  const stats = await repos.stats();
  return { ...stats, user: sessionPayload(session).user };
});

app.get("/admin/api/agents", async (request) => {
  const session = await admin(request, "agent.view");
  const orgIds = await visibleAgentOrgIds(session.principal);
  const agents = await repos.listAgents(orgIds);
  const items = await Promise.all(
    agents.map(async (agent) => {
      const version = agent.published_version_id ? await repos.getAgentVersion(agent.published_version_id) : null;
      return presentAgent(agent, version);
    }),
  );
  return { items };
});

app.post("/admin/api/agents", async (request) => {
  const session = await admin(request, "agent.manage");
  const body = bodyOf(request);
  const key = requireBodyString(body, "key").trim();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(key)) throw errors.invalid("key 必须为小写字母、数字、连字符，2-64 位");
  if (await repos.getAgentByKey(key)) throw errors.conflict("Agent key 已存在");
  const agentId = await repos.createAgent({
    key,
    name: stringBody(body, "name", key),
    description: stringBody(body, "description"),
    ownerOrgUnitId: session.principal.orgUnitId,
    createdBy: session.principal.id,
  });
  const instructions = stringBody(body, "instructions", "You are a helpful assistant.");
  const spec = jsonBody(body, "spec", { model: { provider: "mock", model: "mock-1" }, toolsets: [{ builtin: ["current_time"] }] });
  const versionId = await repos.createAgentVersion({
    agentId,
    version: stringBody(body, "version", "1.0.0"),
    instructions,
    spec,
    status: body.publish === true ? "published" : "draft",
    changelog: "Initial version",
    createdBy: session.principal.id,
  });
  if (body.publish === true) await repos.publishAgentVersion(agentId, versionId);
  await writeAudit(session, "agent.create", "agent", agentId, { key });
  return { id: agentId, versionId };
});

app.get("/admin/api/agents/:id", async (request) => {
  const session = await admin(request, "agent.view");
  const agent = await repos.getAgent(param(request, "id"));
  if (!agent || !(await agentAccessible(session.principal, agent))) throw errors.notFound("Agent 不存在");
  const versions = await repos.listAgentVersions(agent.id);
  return { ...presentAgent(agent), instructions: versions[0]?.instructions ?? null, versions };
});

app.patch("/admin/api/agents/:id", async (request) => {
  const session = await admin(request, "agent.manage");
  const agent = await repos.getAgent(param(request, "id"));
  if (!agent || !(await agentAccessible(session.principal, agent))) throw errors.notFound("Agent 不存在");
  const body = bodyOf(request);
  const fields: Record<string, unknown> = {};
  if (body.name !== undefined) fields.name = stringBody(body, "name");
  if (body.description !== undefined) fields.description = stringBody(body, "description");
  if (body.status !== undefined) fields.status = stringBody(body, "status");
  if (body.apiEnabled !== undefined) fields.api_enabled = body.apiEnabled ? 1 : 0;
  await repos.updateAgent(agent.id, fields);
  await writeAudit(session, "agent.update", "agent", agent.id, fields);
  return { ok: true };
});

app.post("/admin/api/agents/:id/versions", async (request) => {
  const session = await admin(request, "agent.publish");
  const agent = await repos.getAgent(param(request, "id"));
  if (!agent || !(await agentAccessible(session.principal, agent))) throw errors.notFound("Agent 不存在");
  const body = bodyOf(request);
  const versionId = await repos.createAgentVersion({
    agentId: agent.id,
    version: requireBodyString(body, "version"),
    instructions: stringBody(body, "instructions", "You are a helpful assistant."),
    spec: jsonBody(body, "spec", {}),
    status: body.publish === true ? "published" : "draft",
    changelog: stringBody(body, "changelog"),
    createdBy: session.principal.id,
  });
  if (body.publish === true) await repos.publishAgentVersion(agent.id, versionId);
  await writeAudit(session, "agent.version.create", "agent_version", versionId, { agentId: agent.id });
  return { versionId };
});

app.post("/admin/api/agents/:id/publish", async (request) => {
  const session = await admin(request, "agent.publish");
  const agent = await repos.getAgent(param(request, "id"));
  if (!agent || !(await agentAccessible(session.principal, agent))) throw errors.notFound("Agent 不存在");
  const body = bodyOf(request);
  const versionId = requireBodyString(body, "versionId");
  const version = await repos.getAgentVersion(versionId);
  if (!version || version.agent_id !== agent.id) throw errors.notFound("版本不存在");
  await repos.publishAgentVersion(agent.id, versionId);
  await writeAudit(session, "agent.publish", "agent_version", versionId, { agentId: agent.id });
  return { ok: true };
});

app.post("/admin/api/agents/:id/run", async (request) => {
  const session = await admin(request, "agent.run");
  const agent = await repos.getAgent(param(request, "id"));
  if (!agent || !(await agentAccessible(session.principal, agent))) throw errors.notFound("Agent 不存在");
  const body = bodyOf(request);
  const requestedVersion = stringBody(body, "versionId");
  const version = requestedVersion ? await repos.getAgentVersion(requestedVersion) : agent.published_version_id ? await repos.getAgentVersion(agent.published_version_id) : await repos.getPublishedVersion(agent.id);
  if (!version || version.agent_id !== agent.id) throw errors.invalid("Agent 没有可用版本");
  const input = jsonBody(body, "input", { text: stringBody(body, "text", "") });
  const runId = await createQueuedRun({ agentId: agent.id, versionId: version.id, principal: session.principal, input, threadId: stringBody(body, "threadId") || null });
  await writeAudit(session, "run.create", "run", runId, { agentId: agent.id, versionId: version.id });
  const created = await repos.getRun(runId);
  return { runId, threadId: created?.thread_id ?? null, status: "queued" };
});

// ---------- providers / models ----------

app.get("/admin/api/providers", async (request) => {
  await admin(request, "model.view");
  const providers = await repos.listProviders();
  const items = await Promise.all(
    providers.map(async (provider) => ({
      id: provider.id,
      key: provider.key,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.base_url,
      status: provider.status,
      models: (await repos.listModels(provider.id)).map((model) => ({
        id: model.id,
        key: model.key,
        displayName: model.display_name,
        capabilities: model.capabilities_json,
        contextWindow: model.context_window,
        maxOutputTokens: model.max_output_tokens,
      })),
    })),
  );
  return { items };
});

app.post("/admin/api/providers", async (request) => {
  const session = await admin(request, "model.manage");
  const body = bodyOf(request);
  const key = requireBodyString(body, "key");
  if (await repos.getProviderByKey(key)) throw errors.conflict("Provider key 已存在");
  const apiKey = stringBody(body, "apiKey");
  const providerId = await repos.createProvider({
    key,
    name: stringBody(body, "name", key),
    protocol: stringBody(body, "protocol", "openai-compatible"),
    baseUrl: requireBodyString(body, "baseUrl"),
    apiKeyEncrypted: apiKey ? encryptSecret(apiKey, config.FORGE_MASTER_KEY) : null,
    headers: jsonBody(body, "headers", {}),
    timeoutMs: Number(body.timeoutMs ?? 120000),
    createdBy: session.principal.id,
  });
  await writeAudit(session, "provider.create", "llm_provider", providerId, { key });
  return { id: providerId };
});

app.post("/admin/api/providers/:id/models", async (request) => {
  const session = await admin(request, "model.manage");
  const provider = await repos.getProviderById(param(request, "id"));
  if (!provider) throw errors.notFound("Provider 不存在");
  const body = bodyOf(request);
  const modelId = await repos.createModel({
    providerId: provider.id,
    key: requireBodyString(body, "key"),
    displayName: stringBody(body, "displayName", stringBody(body, "key")),
    capabilities: jsonBody(body, "capabilities", ["text", "tools"]),
    contextWindow: Number(body.contextWindow ?? 32768),
    maxOutputTokens: Number(body.maxOutputTokens ?? 4096),
    inputPrice: Number(body.inputPrice ?? 0),
    outputPrice: Number(body.outputPrice ?? 0),
  });
  await writeAudit(session, "model.create", "llm_model", modelId, { providerId: provider.id });
  return { id: modelId };
});

app.patch("/admin/api/providers/:id", async (request) => {
  const session = await admin(request, "model.manage");
  const provider = await repos.getProviderById(param(request, "id"));
  if (!provider) throw errors.notFound("Provider 不存在");
  const body = bodyOf(request);
  const fields: Record<string, unknown> = {};
  if (body.name !== undefined) fields.name = stringBody(body, "name");
  if (body.protocol !== undefined) fields.protocol = stringBody(body, "protocol");
  if (body.baseUrl !== undefined) fields.base_url = stringBody(body, "baseUrl");
  if (body.apiKey) fields.api_key_encrypted = encryptSecret(stringBody(body, "apiKey"), config.FORGE_MASTER_KEY);
  if (body.headers !== undefined) fields.headers_json = jsonBody(body, "headers", {});
  if (body.timeoutMs !== undefined) fields.timeout_ms = Number(body.timeoutMs);
  if (body.status !== undefined) fields.status = stringBody(body, "status");
  await repos.updateProvider(provider.id, fields);
  await writeAudit(session, "provider.update", "llm_provider", provider.id, { name: fields.name, status: fields.status });
  return { ok: true };
});

app.patch("/admin/api/models/:id", async (request) => {
  const session = await admin(request, "model.manage");
  const model = await repos.getModelById(param(request, "id"));
  if (!model) throw errors.notFound("模型不存在");
  const body = bodyOf(request);
  const fields: Record<string, unknown> = {};
  if (body.displayName !== undefined) fields.display_name = stringBody(body, "displayName");
  if (body.capabilities !== undefined) fields.capabilities_json = jsonBody(body, "capabilities", []);
  if (body.contextWindow !== undefined) fields.context_window = Number(body.contextWindow);
  if (body.maxOutputTokens !== undefined) fields.max_output_tokens = Number(body.maxOutputTokens);
  if (body.inputPrice !== undefined) fields.input_price_per_mtok = Number(body.inputPrice);
  if (body.outputPrice !== undefined) fields.output_price_per_mtok = Number(body.outputPrice);
  if (body.status !== undefined) fields.status = stringBody(body, "status");
  await repos.updateModel(model.id, fields);
  await writeAudit(session, "model.update", "llm_model", model.id, { displayName: fields.display_name });
  return { ok: true };
});

app.post("/admin/api/providers/:id/test", async (request) => {
  await admin(request, "model.manage");
  const provider = await repos.getProviderById(param(request, "id"));
  if (!provider) throw errors.notFound("Provider 不存在");
  const models = await repos.listModels(provider.id);
  const model = models[0];
  if (!model) throw errors.invalid("Provider 还没有模型");
  try {
    const result = await callModel({
      providerKey: provider.key,
      modelKey: model.key,
      messages: [{ role: "user", content: "请回复 pong" }],
      tools: [],
    });
    return { ok: true, content: result.content, usage: result.usage };
  } catch (error) {
    return { ok: false, error: error instanceof ForgeError ? error.message : String(error) };
  }
});

// ---------- MCP / tools / skills ----------

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

// ---------- runs / approvals ----------

app.get("/admin/api/runs", async (request) => {
  const session = await admin(request, "run.view");
  const query = request.query as Record<string, unknown>;
  const filter = await runFilterFor(session.principal);
  const runs = await repos.listRuns({
    ...filter,
    status: typeof query.status === "string" ? query.status : undefined,
    limit: Number(query.limit ?? 50),
  });
  const items = await Promise.all(
    runs.map(async (run) => {
      const agent = await repos.getAgent(run.agent_id);
      return { ...presentRun(run), agentName: agent?.name ?? run.agent_id };
    }),
  );
  return { items };
});

app.get("/admin/api/runs/:id", async (request) => {
  const session = await admin(request, "run.view");
  const run = await repos.getRun(param(request, "id"));
  await assertRunAccess(session.principal, run);
  const messages = await repos.listMessages(run!.id);
  const toolCalls = await repos.listToolCalls(run!.id);
  const approvals = (await repos.listApprovals()).filter((approval) => approval.run_id === run!.id);
  return {
    ...presentRun(run!),
    messages: messages.map((message) => ({ id: message.id, seq: message.seq, role: message.role, content: message.content_json, createdAt: message.created_at })),
    toolCalls: toolCalls.map((call) => ({ ...call, args: call.args_json, result: call.result_json })),
    approvals,
  };
});

app.get("/admin/api/runs/:id/events", async (request, reply) => {
  const session = await admin(request, "run.view");
  const run = await repos.getRun(param(request, "id"));
  await assertRunAccess(session.principal, run);
  await streamRun(request, reply, run!.id);
});

app.post("/admin/api/runs/:id/cancel", async (request) => {
  const session = await admin(request, "run.cancel");
  const run = await repos.getRun(param(request, "id"));
  await assertRunAccess(session.principal, run);
  await cancelRun(run!.id);
  await writeAudit(session, "run.cancel", "run", run!.id);
  return { ok: true };
});

app.get("/admin/api/approvals", async (request) => {
  const session = await admin(request, "approval.view");
  const approvals = await repos.listApprovals("pending");
  const visible = [];
  for (const approval of approvals) {
    const run = await repos.getRun(approval.run_id);
    if (!run) continue;
    try {
      await assertRunAccess(session.principal, run);
      visible.push(approval);
    } catch {
      // hide inaccessible approvals
    }
  }
  return { items: visible };
});

app.post("/admin/api/approvals/:id/decide", async (request) => {
  const session = await admin(request, "approval.decide");
  const approval = await repos.getApproval(param(request, "id"));
  if (!approval) throw errors.notFound("审批不存在");
  const run = await repos.getRun(approval.run_id);
  await assertRunAccess(session.principal, run);
  const body = bodyOf(request);
  const decision = stringBody(body, "decision");
  if (!["approved", "rejected"].includes(decision)) throw errors.invalid("decision 必须为 approved/rejected");
  const ok = await repos.decideApproval(approval.id, decision as "approved" | "rejected", session.principal.id, stringBody(body, "comment"));
  if (!ok) throw errors.conflict("审批已处理或已过期");
  await writeAudit(session, "approval.decide", "approval", approval.id, { decision });
  void executeRun(approval.run_id);
  return { ok: true };
});

// ---------- schedules ----------

app.get("/admin/api/schedules", async (request) => {
  const session = await admin(request, "schedule.view");
  const schedules = await repos.listSchedules();
  const items = schedules.filter((schedule) => {
    if (session.principal.dataScope === "all") return true;
    return schedule.org_unit_id === session.principal.orgUnitId;
  });
  return { items };
});

app.post("/admin/api/schedules", async (request) => {
  const session = await admin(request, "schedule.manage");
  const body = bodyOf(request);
  const agent = await repos.getAgent(requireBodyString(body, "agentId"));
  if (!agent || !(await agentAccessible(session.principal, agent))) throw errors.notFound("Agent 不存在");
  if (!agent.published_version_id) throw errors.invalid("Agent 尚未发布");
  const cron = requireBodyString(body, "cron");
  const timezone = stringBody(body, "timezone", "Asia/Shanghai");
  let nextRunAt: Date | null = null;
  try {
    nextRunAt = CronExpressionParser.parse(cron, { currentDate: new Date(), tz: timezone }).next().toDate();
  } catch {
    throw errors.invalid("Cron 表达式无效");
  }
  const id = await repos.createSchedule({
    key: stringBody(body, "key", `schedule-${Date.now()}`),
    name: stringBody(body, "name", "Scheduled Agent"),
    agentId: agent.id,
    orgUnitId: session.principal.orgUnitId,
    subjectType: "user",
    subjectId: session.principal.id,
    cron,
    timezone,
    input: jsonBody(body, "input", { text: "" }),
    status: body.enabled === true ? "active" : "disabled",
    nextRunAt: body.enabled === true ? nextRunAt : null,
    createdBy: session.principal.id,
  });
  await writeAudit(session, "schedule.create", "schedule", id, { agentId: agent.id, cron });
  return { id };
});

app.patch("/admin/api/schedules/:id", async (request) => {
  const session = await admin(request, "schedule.manage");
  const schedule = await repos.getSchedule(param(request, "id"));
  if (!schedule) throw errors.notFound("定时任务不存在");
  if (session.principal.dataScope !== "all" && schedule.org_unit_id !== session.principal.orgUnitId) throw errors.notFound("定时任务不存在");
  const body = bodyOf(request);
  const fields: Record<string, unknown> = {};
  if (body.name !== undefined) fields.name = stringBody(body, "name");
  if (body.cron !== undefined) fields.cron = stringBody(body, "cron");
  if (body.timezone !== undefined) fields.timezone = stringBody(body, "timezone");
  if (body.input !== undefined) fields.input_json = jsonBody(body, "input", {});
  if (body.status !== undefined) fields.status = stringBody(body, "status");
  if (body.cron && body.status === "active") {
    fields.next_run_at = CronExpressionParser.parse(String(fields.cron), { currentDate: new Date(), tz: String(fields.timezone ?? schedule.timezone) }).next().toDate();
  }
  await repos.updateSchedule(schedule.id as string, fields);
  await writeAudit(session, "schedule.update", "schedule", String(schedule.id), fields);
  return { ok: true };
});

app.post("/admin/api/schedules/:id/enable", async (request) => {
  const session = await admin(request, "schedule.manage");
  const schedule = await repos.getSchedule(param(request, "id"));
  if (!schedule) throw errors.notFound("定时任务不存在");
  const next = CronExpressionParser.parse(String(schedule.cron), { currentDate: new Date(), tz: String(schedule.timezone) }).next().toDate();
  await repos.updateSchedule(String(schedule.id), { status: "active", next_run_at: next });
  return { ok: true };
});

app.post("/admin/api/schedules/:id/disable", async (request) => {
  const session = await admin(request, "schedule.manage");
  const schedule = await repos.getSchedule(param(request, "id"));
  if (!schedule) throw errors.notFound("定时任务不存在");
  await repos.updateSchedule(String(schedule.id), { status: "disabled", next_run_at: null });
  return { ok: true };
});

app.post("/admin/api/schedules/:id/run", async (request) => {
  const session = await admin(request, "schedule.run");
  const schedule = await repos.getSchedule(param(request, "id"));
  if (!schedule) throw errors.notFound("定时任务不存在");
  const agent = await repos.getAgent(String(schedule.agent_id));
  if (!agent?.published_version_id) throw errors.invalid("Agent 尚未发布");
  const runId = await createQueuedRun({
    agentId: agent.id,
    versionId: agent.published_version_id,
    principal: session.principal,
    input: parseJsonValue(schedule.input_json, { text: "" }),
    triggerType: "schedule",
    triggerRef: String(schedule.id),
  });
  await writeAudit(session, "schedule.run", "schedule", String(schedule.id), { runId });
  return { runId };
});

// ---------- API apps / users / permissions / plugins ----------

app.get("/admin/api/apps/:id/webhook-deliveries", async (request) => {
  await admin(request, "apikey.view");
  const app = await repos.getApiApp(param(request, "id"));
  if (!app) throw errors.notFound("应用不存在");
  const items = await repos.listWebhookDeliveries(String(app.id));
  return {
    items: items.map((item) => ({
      id: item.id,
      eventId: item.event_id,
      eventType: item.event_type,
      status: item.status,
      attempts: item.attempts,
      responseStatus: item.response_status,
      errorMessage: item.error_message,
      nextAttemptAt: item.next_attempt_at,
      deliveredAt: item.delivered_at,
      createdAt: item.created_at,
    })),
  };
});

app.post("/admin/api/webhook-deliveries/:id/replay", async (request) => {
  const session = await admin(request, "apikey.manage");
  const delivery = await repos.getWebhookDelivery(param(request, "id"));
  if (!delivery) throw errors.notFound("投递记录不存在");
  const replayed = await repos.replayWebhookDelivery(String(delivery.id));
  if (!replayed) throw errors.conflict("投递记录无法重放");
  await writeAudit(session, "webhook.replay", "webhook_delivery", String(delivery.id), { eventId: delivery.event_id });
  await deliverDueWebhooks();
  const fresh = await repos.getWebhookDelivery(String(delivery.id));
  return { ok: true, status: fresh?.status ?? "pending" };
});

app.get("/admin/api/apps", async (request) => {
  await admin(request, "apikey.view");
  const apps = await repos.listApiApps();
  return {
    items: apps.map((app) => ({
      id: app.id,
      key: app.key,
      name: app.name,
      status: app.status,
      scopes: app.scopes_json,
      webhookUrl: app.webhook_url,
      rateLimitPerMinute: app.rate_limit_per_minute,
      dailyQuota: app.daily_quota,
      createdAt: app.created_at,
    })),
  };
});

app.post("/admin/api/apps", async (request) => {
  const session = await admin(request, "apikey.manage");
  const body = bodyOf(request);
  const key = requireBodyString(body, "key");
  const webhookSecret = stringBody(body, "webhookSecret");
  const appId = await repos.createApiApp({
    key,
    name: stringBody(body, "name", key),
    description: stringBody(body, "description"),
    ownerOrgUnitId: session.principal.orgUnitId,
    scopes: arrayBody(body, "scopes").length ? arrayBody(body, "scopes") : ["agents:read", "runs:create", "runs:read", "runs:cancel"],
    webhookUrl: stringBody(body, "webhookUrl") || null,
    webhookSecretEncrypted: webhookSecret ? encryptSecret(webhookSecret, config.FORGE_MASTER_KEY) : null,
    rateLimitPerMinute: Number(body.rateLimitPerMinute ?? 60),
    dailyQuota: Number(body.dailyQuota ?? 1000),
    createdBy: session.principal.id,
  });
  await writeAudit(session, "app.create", "api_app", appId, { key });
  return { id: appId };
});

app.patch("/admin/api/apps/:id", async (request) => {
  const session = await admin(request, "apikey.manage");
  const app = await repos.getApiApp(param(request, "id"));
  if (!app) throw errors.notFound("应用不存在");
  const body = bodyOf(request);
  const fields: Record<string, unknown> = {};
  if (body.name !== undefined) fields.name = stringBody(body, "name");
  if (body.description !== undefined) fields.description = stringBody(body, "description");
  if (body.status !== undefined) fields.status = stringBody(body, "status");
  if (body.scopes !== undefined) fields.scopes_json = arrayBody(body, "scopes");
  if (body.webhookUrl !== undefined) fields.webhook_url = stringBody(body, "webhookUrl") || null;
  if (body.webhookSecret) fields.webhook_secret_encrypted = encryptSecret(stringBody(body, "webhookSecret"), config.FORGE_MASTER_KEY);
  if (body.rateLimitPerMinute !== undefined) fields.rate_limit_per_minute = Number(body.rateLimitPerMinute);
  if (body.dailyQuota !== undefined) fields.daily_quota = Number(body.dailyQuota);
  await repos.updateApiApp(String(app.id), fields);
  await writeAudit(session, "app.update", "api_app", String(app.id), { name: fields.name, status: fields.status });
  return { ok: true };
});

app.post("/admin/api/apps/:id/keys", async (request) => {
  const session = await admin(request, "apikey.manage");
  const app = await repos.getApiApp(param(request, "id"));
  if (!app) throw errors.notFound("应用不存在");
  const body = bodyOf(request);
  const rawKey = `fsk_${randomBytes(32).toString("base64url")}`;
  const prefix = rawKey.slice(0, 16);
  const keyId = await repos.createApiKey({
    appId: String(app.id),
    name: stringBody(body, "name", "default"),
    prefix,
    keyHash: hashApiKey(rawKey, config.API_KEY_PEPPER),
    scopes: Array.isArray(app.scopes_json) ? (app.scopes_json as string[]) : [],
  });
  await writeAudit(session, "apikey.create", "api_key", keyId, { appId: app.id });
  return { id: keyId, key: rawKey, prefix, warning: "此密钥只显示一次，请立即保存" };
});

app.get("/admin/api/apps/:id/keys", async (request) => {
  await admin(request, "apikey.view");
  return { items: await repos.listApiKeys(param(request, "id")) };
});

app.get("/admin/api/users", async (request) => {
  await admin(request, "user.view");
  const users = await repos.listUsers();
  return { items: users.map((user) => ({ ...user, password_hash: undefined })) };
});

app.post("/admin/api/users", async (request) => {
  const session = await admin(request, "user.manage");
  const body = bodyOf(request);
  const email = requireBodyString(body, "email");
  if (await repos.getUserByEmail(email)) throw errors.conflict("邮箱已存在");
  const role = stringBody(body, "role", "user");
  if (!Object.keys(ROLE_PERMISSIONS).includes(role)) throw errors.invalid("非法角色");
  if (session.principal.role !== "platform_admin" && ["platform_admin", "org_admin"].includes(role)) throw errors.forbidden("不能授予该角色");
  const id = await repos.createUser({
    email,
    username: stringBody(body, "username", email.split("@")[0] ?? email),
    displayName: stringBody(body, "displayName", email),
    role,
    dataScope: stringBody(body, "dataScope", defaultDataScope(role as Role)),
    orgUnitId: session.principal.orgUnitId,
    passwordHash: stringBody(body, "password") ? hashPassword(stringBody(body, "password")) : null,
  });
  await writeAudit(session, "user.create", "user", id, { email, role });
  return { id };
});

app.patch("/admin/api/users/:id", async (request) => {
  const session = await admin(request, "user.manage");
  const body = bodyOf(request);
  const target = await repos.getUserById(param(request, "id"));
  if (!target) throw errors.notFound("用户不存在");
  const role = stringBody(body, "role", target.role);
  if (!Object.keys(ROLE_PERMISSIONS).includes(role)) throw errors.invalid("非法角色");
  if (session.principal.role !== "platform_admin" && ["platform_admin", "org_admin"].includes(role)) throw errors.forbidden("不能授予该角色");
  await repos.updateUser(target.id, {
    role,
    dataScope: stringBody(body, "dataScope", defaultDataScope(role as Role)),
    status: body.status !== undefined ? stringBody(body, "status") : undefined,
  });
  await writeAudit(session, "user.update", "user", target.id, { role, dataScope: stringBody(body, "dataScope") });
  return { ok: true };
});

app.get("/admin/api/permissions", async (request) => {
  await admin(request, "role.view");
  return { roles: ROLE_PERMISSIONS };
});

app.get("/admin/api/org-units", async (request) => {
  await admin(request, "org.view");
  return { items: await repos.listOrgUnits() };
});

app.get("/admin/api/role-mappings", async (request) => {
  await admin(request, "sso.manage");
  return { items: await repos.listRoleMappings() };
});

app.post("/admin/api/role-mappings", async (request) => {
  const session = await admin(request, "sso.manage");
  const body = bodyOf(request);
  await repos.upsertRoleMapping(requireBodyString(body, "agentRoleCode"), stringBody(body, "agentRoleName"), requireBodyString(body, "localRole"));
  await writeAudit(session, "role_mapping.upsert", "oidc_role_mapping", null, body);
  return { ok: true };
});

app.get("/admin/api/plugins", async (request) => {
  await admin(request, "package.view");
  return { items: await repos.listPlugins() };
});

app.post("/admin/api/plugins/install", async (request) => {
  const session = await admin(request, "plugin.install");
  const body = bodyOf(request);
  const resources = asRecord(body.resources);
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
  await repos.uninstallPlugin(param(request, "id"));
  await writeAudit(session, "plugin.uninstall", "plugin", param(request, "id"));
  return { ok: true };
});

app.get("/admin/api/audit", async (request) => {
  await admin(request, "audit.view");
  return { items: await repos.listAudit(Number((request.query as Record<string, unknown>).limit ?? 100)) };
});

app.get("/admin/api/sso", async (request) => {
  await admin(request, "sso.manage");
  return {
    mode: config.SSO_MODE,
    tokenValidationMode: config.SSO_TOKEN_VALIDATION_MODE,
    oidcConfigured: oidcConfigured(),
    connectorEnabled: config.AGENT_CONNECTOR_ENABLED,
    connectorInbound: config.AGENT_CONNECTOR_INBOUND_ENABLED,
    connectorOutbound: config.AGENT_CONNECTOR_OUTBOUND_ENABLED,
    mappings: await repos.listRoleMappings(),
  };
});

await app.register(openRoutes);

await app.register(integrationRoutes);

// ---------- static console ----------

app.get("/", async (_request, reply) => {
  const file = path.resolve(process.cwd(), "apps/console/public/index.html");
  return reply.type("text/html").send(fs.readFileSync(file, "utf8"));
});

const port = config.PORT;
await app.listen({ port, host: config.HOST });
if (config.EMBEDDED_WORKER) startRuntime();
console.log(`Forge API listening on ${config.FORGE_PUBLIC_URL} (local http://localhost:${port})`);

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
