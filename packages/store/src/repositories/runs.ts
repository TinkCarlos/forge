import { ulidWithPrefix } from "@forge/core";
import { execute, isRetryableWrite, json, one, query, transaction } from "../db.js";
import type { ApprovalRow, ClaimedRun, MessageRow, RunRow, RunStepRow, ToolCallRow } from "../types.js";

export const runsRepo = {
  // Runs / messages / tools / approvals / events
  async getThread(id: string): Promise<Record<string, unknown> | null> {
    return one("SELECT * FROM threads WHERE id = ?", [id]);
  },
  async createThread(input: { agentId: string; orgUnitId: string | null; subjectType: string; subjectId: string; title?: string }): Promise<string> {
    const id = ulidWithPrefix("thr");
    await execute(
      "INSERT INTO threads (id, agent_id, org_unit_id, subject_type, subject_id, title) VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.agentId, input.orgUnitId, input.subjectType, input.subjectId, input.title ?? ""],
    );
    return id;
  },
  async createRun(input: {
    threadId: string;
    agentId: string;
    agentVersionId: string;
    appId?: string | null;
    orgUnitId?: string | null;
    subjectType: string;
    subjectId: string;
    triggerType?: string;
    triggerRef?: string | null;
    input: unknown;
    status?: string;
    claimedBy?: string | null;
    leaseSeconds?: number | null;
  }): Promise<string> {
    const id = ulidWithPrefix("run");
    const leaseSeconds = input.leaseSeconds == null ? null : Math.max(1, Math.floor(input.leaseSeconds));
    await execute(
      `INSERT INTO runs (id, thread_id, agent_id, agent_version_id, app_id, org_unit_id, subject_type, subject_id, trigger_type, trigger_ref, input_json, status, claimed_by, lease_expires_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, IF(? IS NULL, NULL, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${leaseSeconds ?? 0} SECOND)), IF(? IS NULL, NULL, UTC_TIMESTAMP(3)))`,
      [id, input.threadId, input.agentId, input.agentVersionId, input.appId ?? null, input.orgUnitId ?? null, input.subjectType, input.subjectId, input.triggerType ?? "manual", input.triggerRef ?? null, json(input.input), input.status ?? "queued", input.claimedBy ?? null, leaseSeconds, leaseSeconds],
    );
    return id;
  },
  async getRun(id: string): Promise<RunRow | null> {
    return one<RunRow>("SELECT * FROM runs WHERE id = ?", [id]);
  },
  async listRuns(filter: { orgIds?: string[] | null; subjectType?: string; subjectId?: string; appId?: string; status?: string; limit?: number }): Promise<RunRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.orgIds && filter.orgIds.length === 0) return [];
    if (filter.orgIds && filter.orgIds.length > 0) {
      where.push(`org_unit_id IN (${filter.orgIds.map(() => "?").join(",")})`);
      params.push(...filter.orgIds);
    }
    if (filter.subjectType) { where.push("subject_type = ?"); params.push(filter.subjectType); }
    if (filter.subjectId) { where.push("subject_id = ?"); params.push(filter.subjectId); }
    if (filter.appId) { where.push("app_id = ?"); params.push(filter.appId); }
    if (filter.status) { where.push("status = ?"); params.push(filter.status); }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    params.push(limit);
    return query<RunRow>(`SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`, params);
  },
  async claimNextRun(workerId: string, leaseSeconds: number): Promise<ClaimedRun | null> {
    const seconds = Math.max(1, Math.floor(leaseSeconds));
    return transaction(async (conn) => {
      const [rows] = await conn.query(
        `SELECT id, status FROM runs
         WHERE status = 'queued'
            OR (status = 'running' AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < UTC_TIMESTAMP(3)))
         ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      const candidate = (rows as Array<{ id: string; status: string }>)[0];
      if (!candidate) return null;
      const [result] = await conn.execute(
        `UPDATE runs
         SET status = 'running',
             claimed_by = ?,
             lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${seconds} SECOND),
             heartbeat_at = UTC_TIMESTAMP(3),
             started_at = COALESCE(started_at, UTC_TIMESTAMP(3))
         WHERE id = ?
           AND (
             status = 'queued'
             OR (status = 'running' AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < UTC_TIMESTAMP(3)))
           )`,
        [workerId, candidate.id],
      );
      if ((result as { affectedRows: number }).affectedRows !== 1) return null;
      const [fresh] = await conn.query("SELECT * FROM runs WHERE id = ?", [candidate.id]);
      const run = (fresh as RunRow[])[0];
      if (!run) return null;
      return { run, previousStatus: candidate.status };
    });
  },
  async claimRun(runId: string, workerId: string, leaseSeconds: number, allowWaiting: boolean): Promise<ClaimedRun | null> {
    const seconds = Math.max(1, Math.floor(leaseSeconds));
    const waitingFlag = allowWaiting ? 1 : 0;
    return transaction(async (conn) => {
      const [rows] = await conn.query("SELECT status FROM runs WHERE id = ? FOR UPDATE", [runId]);
      const current = (rows as Array<{ status: string }>)[0];
      if (!current) return null;
      const [result] = await conn.execute(
        `UPDATE runs
         SET status = 'running',
             claimed_by = ?,
             lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${seconds} SECOND),
             heartbeat_at = UTC_TIMESTAMP(3),
             started_at = COALESCE(started_at, UTC_TIMESTAMP(3))
         WHERE id = ?
           AND (
             status = 'queued'
             OR (status = 'waiting_approval' AND ? = 1)
             OR (status = 'running' AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < UTC_TIMESTAMP(3)))
           )`,
        [workerId, runId, waitingFlag],
      );
      if ((result as { affectedRows: number }).affectedRows !== 1) return null;
      const [fresh] = await conn.query("SELECT * FROM runs WHERE id = ?", [runId]);
      const run = (fresh as RunRow[])[0];
      if (!run) return null;
      return { run, previousStatus: current.status };
    });
  },
  async heartbeatRun(id: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const seconds = Math.max(1, Math.floor(leaseSeconds));
    const result = await execute(
      `UPDATE runs
       SET heartbeat_at = UTC_TIMESTAMP(3), lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${seconds} SECOND)
       WHERE id = ? AND claimed_by = ? AND status = 'running'`,
      [id, workerId],
    );
    return result.affectedRows === 1;
  },
  async releaseRunLease(id: string, workerId: string): Promise<void> {
    await execute("UPDATE runs SET claimed_by = NULL, lease_expires_at = NULL, heartbeat_at = NULL WHERE id = ? AND claimed_by = ?", [id, workerId]);
  },
  async expireRunLease(id: string, claimedBy = "expired-worker"): Promise<void> {
    await execute(
      "UPDATE runs SET status = 'running', claimed_by = ?, lease_expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 60 SECOND), heartbeat_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 60 SECOND) WHERE id = ?",
      [claimedBy, id],
    );
  },
  async updateRun(id: string, fields: {
    status?: string; output?: unknown; usage?: unknown; costUsd?: number; errorCode?: string | null; errorMessage?: string | null; cancelRequested?: boolean; startedAt?: Date | null; completedAt?: Date | null;
  }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.status) { sets.push("status = ?"); params.push(fields.status); }
    if (fields.output !== undefined) { sets.push("output_json = ?"); params.push(json(fields.output)); }
    if (fields.usage !== undefined) { sets.push("usage_json = ?"); params.push(json(fields.usage)); }
    if (fields.costUsd !== undefined) { sets.push("cost_usd = ?"); params.push(fields.costUsd); }
    if (fields.errorCode !== undefined) { sets.push("error_code = ?"); params.push(fields.errorCode); }
    if (fields.errorMessage !== undefined) { sets.push("error_message = ?"); params.push(fields.errorMessage); }
    if (fields.cancelRequested !== undefined) { sets.push("cancel_requested = ?"); params.push(fields.cancelRequested ? 1 : 0); }
    if (fields.startedAt !== undefined) { sets.push("started_at = ?"); params.push(fields.startedAt); }
    if (fields.completedAt !== undefined) { sets.push("completed_at = ?"); params.push(fields.completedAt); }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async requestCancel(id: string): Promise<void> {
    await execute("UPDATE runs SET cancel_requested = 1 WHERE id = ?", [id]);
  },
  async addMessage(input: { threadId: string; runId: string; seq: number; role: string; content: unknown }): Promise<string> {
    const id = ulidWithPrefix("msg");
    await execute(
      "INSERT INTO messages (id, thread_id, run_id, seq, role, content_json) VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.threadId, input.runId, input.seq, input.role, json(input.content)],
    );
    return id;
  },
  async listMessages(runId: string): Promise<MessageRow[]> {
    return query<MessageRow>("SELECT * FROM messages WHERE run_id = ? ORDER BY seq", [runId]);
  },
  async listThreadMessages(threadId: string): Promise<MessageRow[]> {
    return query<MessageRow>("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, seq", [threadId]);
  },
  async nextMessageSeq(runId: string): Promise<number> {
    const row = await one<{ maxSeq: number | null }>("SELECT MAX(seq) AS maxSeq FROM messages WHERE run_id = ?", [runId]);
    return Number(row?.maxSeq ?? 0) + 1;
  },
  async addToolCall(input: { runId: string; toolKey: string; args: unknown; risk: string; status?: string; approvalId?: string | null; idempotencyKey?: string | null; attempt?: number }): Promise<string> {
    if (input.idempotencyKey) {
      const existing = await one<{ id: string }>("SELECT id FROM tool_calls WHERE run_id = ? AND idempotency_key = ?", [input.runId, input.idempotencyKey]);
      if (existing) return existing.id;
    }
    const id = ulidWithPrefix("tcl");
    try {
      await execute(
        "INSERT INTO tool_calls (id, run_id, tool_key, args_json, risk_level, status, approval_id, idempotency_key, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, input.runId, input.toolKey, json(input.args), input.risk, input.status ?? "running", input.approvalId ?? null, input.idempotencyKey ?? null, input.attempt ?? 1],
      );
      return id;
    } catch (error) {
      const errno = (error as { errno?: number }).errno;
      if (errno === 1062 && input.idempotencyKey) {
        const existing = await one<{ id: string }>("SELECT id FROM tool_calls WHERE run_id = ? AND idempotency_key = ?", [input.runId, input.idempotencyKey]);
        if (existing) return existing.id;
      }
      throw error;
    }
  },
  async updateToolCall(id: string, fields: { status?: string; result?: unknown; resultText?: string | null; errorCode?: string | null; approvalId?: string | null; attempt?: number }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.status) { sets.push("status = ?"); params.push(fields.status); }
    if (fields.result !== undefined) { sets.push("result_json = ?"); params.push(json(fields.result)); }
    if (fields.resultText !== undefined) { sets.push("result_text = ?"); params.push(fields.resultText); }
    if (fields.errorCode !== undefined) { sets.push("error_code = ?"); params.push(fields.errorCode); }
    if (fields.approvalId !== undefined) { sets.push("approval_id = ?"); params.push(fields.approvalId); }
    if (fields.attempt !== undefined) { sets.push("attempt = ?"); params.push(fields.attempt); }
    if (!sets.length) return;
    params.push(id);
    await execute(`UPDATE tool_calls SET ${sets.join(", ")} WHERE id = ?`, params);
  },
  async getToolCall(id: string): Promise<ToolCallRow | null> {
    return one<ToolCallRow>("SELECT * FROM tool_calls WHERE id = ?", [id]);
  },
  async listToolCalls(runId: string): Promise<ToolCallRow[]> {
    return query<ToolCallRow>("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY created_at", [runId]);
  },
  async addApproval(input: { runId: string; toolCallId: string; risk: string; timeoutSeconds: number }): Promise<string> {
    const id = ulidWithPrefix("apr");
    await execute(
      "INSERT INTO approvals (id, run_id, tool_call_id, risk_level, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND))",
      [id, input.runId, input.toolCallId, input.risk, input.timeoutSeconds],
    );
    await execute("UPDATE tool_calls SET status = 'pending_approval', approval_id = ? WHERE id = ?", [id, input.toolCallId]);
    return id;
  },
  async getApproval(id: string): Promise<ApprovalRow | null> {
    return one<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", [id]);
  },
  async listApprovals(status?: string): Promise<Array<ApprovalRow & { agent_name?: string }>> {
    const where = status ? "WHERE a.status = ?" : "";
    const params = status ? [status] : [];
    return query<Array<ApprovalRow & { agent_name?: string }>[number]>(
      `SELECT a.*, ag.name AS agent_name FROM approvals a JOIN runs r ON r.id = a.run_id JOIN agents ag ON ag.id = r.agent_id ${where} ORDER BY a.created_at DESC LIMIT 100`,
      params,
    );
  },
  /**
   * Pending-style approval list with the caller's run visibility applied in SQL (mirrors canAccessRun):
   * appId key present -> r.app_id = appId (missing appId -> nothing); orgIds [] -> nothing, else r.org_unit_id IN (...)
   * (NULL org never matches); subjectType/subjectId -> exact match; {} -> everything.
   * Returns the page plus the total visible count; tool fields come from a LEFT JOIN on tool_calls.
   */
  async listApprovalsVisible(input: {
    status: string;
    scope: { orgIds?: string[] | null; subjectType?: string; subjectId?: string; appId?: string };
    limit: number;
    offset: number;
  }): Promise<{ rows: Array<ApprovalRow & { agent_id: string; agent_name: string; tool_key: string | null; tool_args: unknown }>; total: number }> {
    const { scope } = input;
    const where: string[] = ["a.status = ?"];
    const params: unknown[] = [input.status];
    if ("appId" in scope) {
      if (!scope.appId) return { rows: [], total: 0 };
      where.push("r.app_id = ?");
      params.push(scope.appId);
    }
    if (Array.isArray(scope.orgIds)) {
      if (scope.orgIds.length === 0) return { rows: [], total: 0 };
      where.push(`r.org_unit_id IN (${scope.orgIds.map(() => "?").join(",")})`);
      params.push(...scope.orgIds);
    }
    if (scope.subjectType !== undefined) { where.push("r.subject_type = ?"); params.push(scope.subjectType); }
    if (scope.subjectId !== undefined) { where.push("r.subject_id = ?"); params.push(scope.subjectId); }
    const from = `FROM approvals a JOIN runs r ON r.id = a.run_id JOIN agents ag ON ag.id = r.agent_id
       LEFT JOIN tool_calls tc ON tc.id = a.tool_call_id
       WHERE ${where.join(" AND ")}`;
    const counted = await one<{ total: number }>(`SELECT COUNT(*) AS total ${from}`, params);
    const limit = Math.min(Math.max(Math.floor(input.limit), 1), 100);
    const offset = Math.max(Math.floor(input.offset), 0);
    const rows = await query<ApprovalRow & { agent_id: string; agent_name: string; tool_key: string | null; tool_args: unknown }>(
      `SELECT a.*, r.agent_id AS agent_id, ag.name AS agent_name, tc.tool_key AS tool_key, tc.args_json AS tool_args
       ${from} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { rows, total: Number(counted?.total ?? 0) };
  },
  async decideApproval(id: string, decision: "approved" | "rejected", decidedBy: string, comment: string): Promise<boolean> {
    const result = await execute(
      "UPDATE approvals SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP(3), comment = ? WHERE id = ? AND status = 'pending'",
      [decision, decidedBy, comment, id],
    );
    return result.affectedRows === 1;
  },
  async listPendingApprovedCalls(runId: string): Promise<Array<ToolCallRow & { approval_status: string }>> {
    return query(
      `SELECT tc.*, a.status AS approval_status FROM tool_calls tc JOIN approvals a ON a.id = tc.approval_id
       WHERE tc.run_id = ? AND tc.status = 'pending_approval' AND a.status IN ('approved','rejected') ORDER BY tc.created_at`,
      [runId],
    );
  },
  async listExpiredToolCalls(runId: string): Promise<Array<ToolCallRow & { approval_status: string }>> {
    return query(
      `SELECT tc.*, a.status AS approval_status FROM tool_calls tc JOIN approvals a ON a.id = tc.approval_id
       WHERE tc.run_id = ? AND tc.status = 'pending_approval' AND a.status = 'expired' ORDER BY tc.created_at`,
      [runId],
    );
  },
  async listOpenToolCalls(runId: string): Promise<Array<ToolCallRow & { approval_status: string | null }>> {
    return query(
      `SELECT tc.*, a.status AS approval_status FROM tool_calls tc LEFT JOIN approvals a ON a.id = tc.approval_id
       WHERE tc.run_id = ? AND tc.status IN ('pending','pending_approval','running') ORDER BY tc.created_at`,
      [runId],
    );
  },
  async timeoutApprovals(runId: string): Promise<number> {
    const result = await execute("UPDATE approvals SET status = 'expired', decided_at = CURRENT_TIMESTAMP(3) WHERE run_id = ? AND status = 'pending' AND expires_at < CURRENT_TIMESTAMP(3)", [runId]);
    return result.affectedRows;
  },
  async addRunStep(input: { runId: string; type: string; status?: string; summary?: unknown; toolCallId?: string | null }): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await transaction(async (conn) => {
          const [rows] = await conn.execute("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM run_steps WHERE run_id = ? FOR UPDATE", [input.runId]);
          const seq = Number((rows as Array<{ maxSeq: number }>)[0]?.maxSeq ?? 0) + 1;
          const id = ulidWithPrefix("stp");
          const status = input.status ?? "running";
          await conn.execute(
            "INSERT INTO run_steps (id, run_id, seq, type, status, tool_call_id, summary_json, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, IF(? IN ('succeeded','failed'), UTC_TIMESTAMP(3), NULL))",
            [id, input.runId, seq, input.type, status, input.toolCallId ?? null, json(input.summary ?? null), status],
          );
          return id;
        });
      } catch (error) {
        if (!isRetryableWrite(error) || attempt === 4) throw error;
      }
    }
    throw new Error("failed to allocate run step");
  },
  async finishRunStep(id: string, fields: { status: string; errorCode?: string | null; summary?: unknown; inputTokens?: number; outputTokens?: number; costUsd?: number }): Promise<void> {
    await execute(
      "UPDATE run_steps SET status = ?, error_code = ?, summary_json = COALESCE(?, summary_json), input_tokens = ?, output_tokens = ?, cost_usd = ?, ended_at = UTC_TIMESTAMP(3) WHERE id = ?",
      [fields.status, fields.errorCode ?? null, fields.summary === undefined ? null : json(fields.summary), fields.inputTokens ?? 0, fields.outputTokens ?? 0, fields.costUsd ?? 0, id],
    );
  },
  async listRunSteps(runId: string): Promise<RunStepRow[]> {
    return query<RunStepRow>("SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq", [runId]);
  },
  async failRunningSteps(runId: string, type: string, errorCode: string): Promise<number> {
    const result = await execute(
      "UPDATE run_steps SET status = 'failed', error_code = ?, ended_at = UTC_TIMESTAMP(3) WHERE run_id = ? AND type = ? AND status = 'running'",
      [errorCode, runId, type],
    );
    return result.affectedRows;
  },
  async addEvent(runId: string, type: string, data: unknown): Promise<number> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await transaction(async (conn) => {
          const [rows] = await conn.execute("SELECT COALESCE(MAX(seq),0) AS maxSeq FROM run_events WHERE run_id = ? FOR UPDATE", [runId]);
          const maxSeq = Number((rows as Array<{ maxSeq: number }>)[0]?.maxSeq ?? 0);
          const seq = maxSeq + 1;
          await conn.execute("INSERT INTO run_events (run_id, seq, type, data_json) VALUES (?, ?, ?, ?)", [runId, seq, type, json(data)]);
          return seq;
        });
      } catch (error) {
        if (!isRetryableWrite(error) || attempt === 7) throw error;
      }
    }
    throw new Error("failed to allocate run event");
  },
  async listEvents(runId: string, afterSeq = 0): Promise<Array<{ run_id: string; seq: number; type: string; data_json: unknown; created_at: Date }>> {
    return query("SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq", [runId, afterSeq]);
  },
};
