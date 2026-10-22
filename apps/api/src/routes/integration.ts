import { type FastifyInstance, type FastifyRequest } from "fastify";
import { errors, ForgeError, type Principal } from "@forge/core";
import { assertRunAccess } from "@forge/governance";
import { principalForConnector, verifyConnectorPrincipal } from "@forge/identity";
import { cancelRun, createQueuedRun } from "@forge/runtime";
import { repos } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  jsonBody,
  presentRun,
  requireBodyString,
} from "../plugins/http-helpers.js";

async function connectorUser(request: FastifyRequest): Promise<Principal> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw errors.unauthorized("缺少 Connector Principal");
  const payload = await verifyConnectorPrincipal(header.slice(7));
  return principalForConnector(payload);
}

export default async function integrationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/integration/v1/agents", async (request) => {
    await connectorUser(request);
    const agents = await repos.listAgents(null);
    const items = [];
    for (const agent of agents) {
      if (!agent.published_version_id) continue;
      const version = await repos.getAgentVersion(agent.published_version_id);
      items.push({ key: agent.key, name: agent.name, description: agent.description, version: version?.version ?? null });
    }
    return { items };
  });

  app.post("/integration/v1/runs", async (request, reply) => {
    const principal = await connectorUser(request);
    const body = bodyOf(request);
    const agent = await repos.getAgentByKey(requireBodyString(body, "agentKey"));
    if (!agent || !agent.published_version_id) throw errors.notFound("Agent 不存在");
    const runId = await createQueuedRun({
      agentId: agent.id,
      versionId: agent.published_version_id,
      principal,
      input: jsonBody(body, "input", { text: stringBody(body, "text", "") }),
      triggerType: "connector",
      triggerRef: null,
    });
    reply.status(202);
    return { runId, status: "queued" };
  });

  app.get("/integration/v1/runs/:id", async (request) => {
    const principal = await connectorUser(request);
    const run = await repos.getRun(param(request, "id"));
    await assertRunAccess(principal, run);
    return presentRun(run!);
  });

  app.get("/integration/v1/runs/:id/result", async (request) => {
    const principal = await connectorUser(request);
    const run = await repos.getRun(param(request, "id"));
    await assertRunAccess(principal, run);
    if (!["succeeded", "failed", "cancelled", "budget_exhausted"].includes(run!.status)) throw new ForgeError("RUN-7002", "Run 尚未结束", 409, { status: run!.status });
    return { runId: run!.id, status: run!.status, output: run!.output_json, error: run!.error_code ? { code: run!.error_code, message: run!.error_message } : null, usage: run!.usage_json };
  });

  app.post("/integration/v1/runs/:id/cancel", async (request) => {
    const principal = await connectorUser(request);
    const run = await repos.getRun(param(request, "id"));
    await assertRunAccess(principal, run);
    await cancelRun(run!.id);
    return { ok: true };
  });
}
