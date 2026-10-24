import { type FastifyInstance, type FastifyRequest } from "fastify";
import { errors, ForgeError, type Principal } from "@forge/core";
import { assertPermission, assertRunAccess, visibleAgentOrgIds } from "@forge/governance";
import { principalForConnector, verifyConnectorPrincipal } from "@forge/identity";
import { assertAgentRunnable, cancelRun, createQueuedRun } from "@forge/runtime";
import { repos } from "@forge/store";
import {
  agentAccessible,
  bodyOf,
  param,
  stringBody,
  jsonBody,
  presentRun,
  presentRunOutput,
  requireBodyString,
} from "../plugins/http-helpers.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../plugins/input-schema.js";

async function connectorUser(request: FastifyRequest): Promise<Principal> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw errors.unauthorized("缺少 Connector Principal");
  const payload = await verifyConnectorPrincipal(header.slice(7), request.server.forgeConfig);
  return principalForConnector(payload);
}

export default async function integrationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/integration/v1/agents", async (request) => {
    const principal = await connectorUser(request);
    // F9: functional permission first (403 POL-2001), then the scope filter below (unchanged).
    assertPermission(principal, "agent.view");
    // I-INT-17: same visibility as agentAccessible (mapped user's department subtree + unowned); disabled Agents are
    // not runnable, so they are not listed either.
    const agents = await repos.listAgents(await visibleAgentOrgIds(principal));
    const items = [];
    for (const agent of agents) {
      if (!agent.published_version_id || agent.status !== "active") continue;
      const version = await repos.getAgentVersion(agent.published_version_id);
      items.push({ key: agent.key, name: agent.name, description: agent.description, version: version?.version ?? null });
    }
    return { items };
  });

  app.post("/integration/v1/runs", { schema: ROUTE_SCHEMAS.integrationRun, attachValidation: true }, async (request, reply) => {
    const principal = await connectorUser(request);
    // P0-04 / I-INT-11: the caller is always a Connector principal mapped to a Forge user, so the user's functional
    // permission applies (403 POL-2001) before the scope check below (agentAccessible, unchanged).
    assertPermission(principal, "agent.run");
    assertValidInput(request);
    const body = bodyOf(request);
    const agent = await repos.getAgentByKey(requireBodyString(body, "agentKey"));
    // I-INT-17: outside the mapped user's scope -> the same 404 as a missing Agent (checked before status).
    if (!agent || !agent.published_version_id || !(await agentAccessible(principal, agent))) throw errors.notFound("Agent 不存在");
    assertAgentRunnable(agent);
    const runId = await createQueuedRun({
      agentId: agent.id,
      versionId: agent.published_version_id,
      principal,
      input: jsonBody(body, "input", { text: stringBody(body, "text", "") }),
      triggerType: "connector",
      triggerRef: null,
    });
    await repos.audit({ actorType: "user", actorId: principal.id, action: "integration.run.create", resourceType: "run", resourceId: runId, details: { agentKey: agent.key } });
    reply.status(202);
    return { runId, status: "queued" };
  });

  app.get("/integration/v1/runs/:id", async (request) => {
    const principal = await connectorUser(request);
    // F9: run.view first (403 POL-2001, also before 404); assertRunAccess (scope) stays.
    assertPermission(principal, "run.view");
    const run = await repos.getRun(param(request, "id"));
    await assertRunAccess(principal, run);
    return presentRun(run!);
  });

  app.get("/integration/v1/runs/:id/result", async (request) => {
    const principal = await connectorUser(request);
    // F9: run.view first (403 POL-2001, also before 404); assertRunAccess (scope) stays.
    assertPermission(principal, "run.view");
    const run = await repos.getRun(param(request, "id"));
    await assertRunAccess(principal, run);
    if (!["succeeded", "failed", "cancelled", "budget_exhausted"].includes(run!.status)) throw new ForgeError("RUN-7002", "Run 尚未结束", 409, { status: run!.status });
    return { runId: run!.id, status: run!.status, output: presentRunOutput(run!.output_json), error: run!.error_code ? { code: run!.error_code, message: run!.error_message } : null, usage: run!.usage_json };
  });

  app.post("/integration/v1/runs/:id/cancel", async (request) => {
    const principal = await connectorUser(request);
    // P0-05 / I-INT-15: same as above with run.cancel; the scope check (assertRunAccess) stays.
    assertPermission(principal, "run.cancel");
    const run = await repos.getRun(param(request, "id"));
    await assertRunAccess(principal, run);
    await cancelRun(run!.id);
    await repos.audit({ actorType: "user", actorId: principal.id, action: "integration.run.cancel", resourceType: "run", resourceId: run!.id });
    return { ok: true };
  });
}
