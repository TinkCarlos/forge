import { type FastifyInstance } from "fastify";
import { errors, ForgeError } from "@forge/core";
import { assertRunAccess, buildArgsPreview, canAccessRun, maskArgsDeep, runFilterFor } from "@forge/governance";
import { cancelRun, describeTickError, executeRun, isRunFinished, RUN_FINISHED_CODE } from "@forge/runtime";
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
import { ROUTE_SCHEMAS, assertValidInput, limitParam } from "../../plugins/input-schema.js";

export default async function adminRunRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/api/runs", { schema: ROUTE_SCHEMAS.runsList, attachValidation: true }, async (request) => {
    const session = await admin(request, "run.view");
    assertValidInput(request, "querystring");
    const query = request.query as Record<string, unknown>;
    const filter = await runFilterFor(session.principal);
    const runs = await repos.listRuns({
      ...filter,
      status: typeof query.status === "string" ? query.status : undefined,
      limit: limitParam(request, 50),
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
      messages: messages.map((message) => ({ id: message.id, seq: message.seq, role: message.role, content: maskMessageContent(message.role, message.content_json), createdAt: message.created_at })),
      // Tool arguments AND results are masked (same rules as args_preview, structure kept; U-12): a tool may echo
      // credentials back (Authorization headers, token responses). Stored rows keep the raw values.
      toolCalls: toolCalls.map((call) => {
        const args = maskArgsDeep(call.args_json);
        const result = maskArgsDeep(call.result_json);
        return { ...call, args_json: args, args, result_json: result, result, result_text: maskArgsDeep(call.result_text) };
      }),
      approvals,
    };
  });

  app.get("/admin/api/runs/:id/events", async (request, reply) => {
    const session = await admin(request, "run.view");
    const run = await repos.getRun(param(request, "id"));
    await assertRunAccess(session.principal, run);
    await streamRun(request, reply, run!.id);
  });

  app.post("/admin/api/runs/:id/cancel", { schema: ROUTE_SCHEMAS.noBody, attachValidation: true }, async (request) => {
    const session = await admin(request, "run.cancel");
    const run = await repos.getRun(param(request, "id"));
    await assertRunAccess(session.principal, run);
    assertValidInput(request);
    await cancelRun(run!.id);
    await writeAudit(session, "run.cancel", "run", run!.id);
    return { ok: true };
  });

  // Pending approvals visible to the caller. Scope is applied in SQL so `total` and pages match what the caller can see.
  // No `page`/`pageSize` -> `{ items }` (first 100, as before). With either -> `{ items, page, pageSize, total }`.
  // Raw tool arguments never leave the server: only `tool_name` and the masked `args_preview`.
  app.get("/admin/api/approvals", async (request) => {
    const session = await admin(request, "approval.view");
    const query = request.query as Record<string, unknown>;
    const paged = query.page !== undefined || query.pageSize !== undefined;
    const page = paged ? positiveInt(query.page, 1, "page") : 1;
    const pageSize = paged ? Math.min(positiveInt(query.pageSize, 20, "pageSize"), 100) : 100;
    const scope = await runFilterFor(session.principal);
    const { rows, total } = await repos.listApprovalsVisible({ status: "pending", scope, limit: pageSize, offset: (page - 1) * pageSize });
    const items = rows.map(({ tool_key, tool_args, ...row }) => ({ ...row, tool_name: tool_key ?? null, args_preview: tool_key == null ? null : buildArgsPreview(tool_args) }));
    return paged ? { items, page, pageSize, total } : { items };
  });

  app.post("/admin/api/approvals/:id/decide", { schema: ROUTE_SCHEMAS.approvalDecide, attachValidation: true }, async (request) => {
    const session = await admin(request, "approval.decide");
    // Missing approval, missing run and a run outside the caller's scope all answer the same 404 「审批不存在」 (no Run details).
    const approval = await repos.getApproval(param(request, "id"));
    const run = approval ? await repos.getRun(approval.run_id) : null;
    if (!approval || !run || !(await canAccessRun(session.principal, run))) throw errors.notFound("审批不存在");
    const body = bodyOf(request);
    assertValidInput(request);
    const decision = body.decision as "approved" | "rejected";
    const comment = typeof body.comment === "string" ? body.comment : undefined;
    // I-APR-38: the Run already ended -> the approval is no longer operable (pending -> expired), 409 RUN-7005, no audit,
    // no executeRun. Checked here at the API, not in the loop.
    if (isRunFinished(run.status)) {
      await repos.expirePendingApproval(approval.id);
      throw new ForgeError(RUN_FINISHED_CODE, "Run 已结束，审批不可操作", 409);
    }
    const ok = await repos.decideApproval(approval.id, decision, session.principal.id, comment ?? "");
    if (!ok) throw errors.conflict("审批已处理或已过期");
    await writeAudit(session, "approval.decide", "approval", approval.id, { decision });
    // Fire-and-forget like the worker (K-20): a rejected executeRun is logged (sanitized), never an unhandled rejection.
    void executeRun(approval.run_id).catch((error) => console.error(`Run ${approval.run_id} execution failed: ${describeTickError(error)}`));
    return { ok: true };
  });
}

/**
 * User messages are user input, tool messages carry tool results, assistant messages carry model text and tool_calls
 * arguments -> all masked whole with the shared rules (U-12; P2 QA 714b3f3: assistant text too, prose credentials).
 */
function maskMessageContent(role: string, content: unknown): unknown {
  if (role === "user" || role === "tool" || role === "assistant") return maskArgsDeep(content);
  return content;
}

function positiveInt(raw: unknown, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw errors.invalid(`${name} 必须是正整数`);
  return value;
}
