import { type FastifyInstance } from "fastify";
import { errors } from "@forge/core";
import { assertRunAccess, runFilterFor } from "@forge/governance";
import { cancelRun, executeRun } from "@forge/runtime";
import { repos } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  admin,
  writeAudit,
  presentRun,
  streamRun,
} from "../../plugins/http-helpers.js";

export default async function adminRunRoutes(app: FastifyInstance): Promise<void> {
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
}
