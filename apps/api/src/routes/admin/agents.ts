import { type FastifyInstance } from "fastify";
import { errors } from "@forge/core";
import { visibleAgentOrgIds } from "@forge/governance";
import { createQueuedRun } from "@forge/runtime";
import { repos } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  jsonBody,
  admin,
  writeAudit,
  agentAccessible,
  presentAgent,
  requireBodyString,
  sessionPayload,
} from "../../plugins/http-helpers.js";

export default async function adminAgentRoutes(app: FastifyInstance): Promise<void> {
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
}
