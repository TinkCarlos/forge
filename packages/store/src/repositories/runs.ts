import { ForgeError, ulidWithPrefix } from "@forge/core";
import type { ResultSetHeader } from "mysql2/promise";
import { execute, isRetryableWrite, json, one, query, transaction } from "../db.js";
import { activeFence, fenceOwnerFor, LeaseLostError } from "../lease-fence.js";
import type { ApprovalRow, ClaimedRun, MessageRow, RunRow, RunStepRow, ToolCallRow } from "../types.js";

// P3-09 lease fence (see lease-fence.ts): inside withRunLease(runId, owner) the run-scoped writes below carry the
// lease holder condition runs.claimed_by = owner. Inserts become INSERT ... SELECT ... FROM runs WHERE id = ? AND
// claimed_by = ?; updates of a child row (tool call, step) add CHILD_FENCE (fenced only when the row belongs to the
// scope's Run). 0 affected rows: the lease is re-checked and a lost lease throws LeaseLostError (the write is dropped).
const CHILD_FENCE = (table: string) => `EXISTS (SELECT 1 FROM runs fence_run WHERE fence_run.id = ${table}.run_id AND (fence_run.id <> ? OR fence_run.claimed_by = ?))`;

async function assertLeaseOwned(runId: string, owner: string): Promise<void> {
  const row = await one<{ held: number }>("SELECT 1 AS held FROM runs WHERE id = ? AND claimed_by = ?", [runId, owner]);
  if (!row) throw new LeaseLostError();
}

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
    const owner = fenceOwnerFor(id);
    if (owner === null) {
      await execute(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`, params);
      return;
    }
    const result = await execute(`UPDATE runs SET ${sets.join(", ")} WHERE id = ? AND claimed_by = ?`, [...params, owner]);
    if (result.affectedRows === 0) await assertLeaseOwned(id, owner);
  },
  async requestCancel(id: string): Promise<void> {
    await execute("UPDATE runs SET cancel_requested = 1 WHERE id = ?", [id]);
  },
  async addMessage(input: { threadId: string; runId: string; seq: number; role: string; content: unknown }): Promise<string> {
    const id = ulidWithPrefix("msg");
    const values = [id, input.threadId, input.runId, input.seq, input.role, json(input.content)];
    const owner = fenceOwnerFor(input.runId);
    if (owner === null) {
      await execute("INSERT INTO messages (id, thread_id, run_id, seq, role, content_json) VALUES (?, ?, ?, ?, ?, ?)", values);
      return id;
    }
    const result = await execute(
      "INSERT INTO messages (id, thread_id, run_id, seq, role, content_json) SELECT ?, ?, ?, ?, ?, ? FROM runs WHERE id = ? AND claimed_by = ?",
      [...values, input.runId, owner],
    );
    if (result.affectedRows === 0) throw new LeaseLostError();
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
  /**
   * Stores one tool call. Identity (Q5): a call is unique per (run, model_step, step_index) and `idempotencyKey` is
   * `<runId>:s<model_step>:<step_index>` (the caller builds it; uk_tool_calls_run_idem is the DB guard). An existing row
   * with the same key is the replay of this call only when it is for the same tool; anything else (e.g. a pre-1.3 row
   * whose `<runId>:<provider id>` key happens to look like the new format) is a conflict: SYS-9001, never a silent reuse.
   * `callId` is the provider's id, kept for audit only (never a key, never replayed): "" is stored as NULL, longer than
   * 191 is truncated.
   */
  async addToolCall(input: {
    runId: string;
    toolKey: string;
    args: unknown;
    risk: string;
    status?: string;
    approvalId?: string | null;
    idempotencyKey?: string | null;
    attempt?: number;
    readOnly?: boolean;
    callId?: string | null;
    modelStep?: number | null;
    stepIndex?: number | null;
  }): Promise<string> {
    const replayOf = async (): Promise<string | null> => {
      if (!input.idempotencyKey) return null;
      const existing = await one<{ id: string; tool_key: string }>("SELECT id, tool_key FROM tool_calls WHERE run_id = ? AND idempotency_key = ?", [input.runId, input.idempotencyKey]);
      if (!existing) return null;
      if (existing.tool_key !== input.toolKey) throw new ForgeError("SYS-9001", "工具调用记录冲突", 500);
      return existing.id;
    };
    const replayed = await replayOf();
    if (replayed) return replayed;
    const id = ulidWithPrefix("tcl");
    const callId = typeof input.callId === "string" && input.callId !== "" ? input.callId.slice(0, 191) : null;
    const values = [
      id, input.runId, input.toolKey, json(input.args), input.risk, input.status ?? "running", input.approvalId ?? null, input.idempotencyKey ?? null, input.attempt ?? 1,
      input.readOnly === true ? 1 : 0, callId, input.modelStep ?? null, input.stepIndex ?? null,
    ];
    const columns = "id, run_id, tool_key, args_json, risk_level, status, approval_id, idempotency_key, attempt, read_only, call_id, model_step, step_index";
    const owner = fenceOwnerFor(input.runId);
    try {
      if (owner === null) {
        await execute(`INSERT INTO tool_calls (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, values);
        return id;
      }
      const result = await execute(
        `INSERT INTO tool_calls (${columns}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM runs WHERE id = ? AND claimed_by = ?`,
        [...values, input.runId, owner],
      );
      if (result.affectedRows === 0) throw new LeaseLostError();
      return id;
    } catch (error) {
      const errno = (error as { errno?: number }).errno;
      if (errno === 1062 && input.idempotencyKey) {
        const existing = await replayOf();
        if (existing) return existing;
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
    const fence = activeFence();
    if (fence === null) {
      await execute(`UPDATE tool_calls SET ${sets.join(", ")} WHERE id = ?`, params);
      return;
    }
    const result = await execute(`UPDATE tool_calls SET ${sets.join(", ")} WHERE id = ? AND ${CHILD_FENCE("tool_calls")}`, [...params, fence.runId, fence.owner]);
    if (result.affectedRows === 0) await assertLeaseOwned(fence.runId, fence.owner);
  },
  async getToolCall(id: string): Promise<ToolCallRow | null> {
    return one<ToolCallRow>("SELECT * FROM tool_calls WHERE id = ?", [id]);
  },
  async listToolCalls(runId: string): Promise<ToolCallRow[]> {
    return query<ToolCallRow>("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY created_at", [runId]);
  },
  /**
   * Creates a pending approval for a tool call (the call becomes pending_approval and points at it). r5: `reason` is
   * "policy" (default) or "interrupted" (a side-effect call found running at takeover); returns the id and expires_at
   * (UTC, DB clock) so approval.required can carry it.
   */
  async addApproval(input: { runId: string; toolCallId: string; risk: string; timeoutSeconds: number; reason?: "policy" | "interrupted" }): Promise<{ id: string; expiresAt: Date }> {
    const id = ulidWithPrefix("apr");
    const values = [id, input.runId, input.toolCallId, input.risk, input.reason ?? "policy", input.timeoutSeconds];
    const owner = fenceOwnerFor(input.runId);
    if (owner === null) {
      await execute("INSERT INTO approvals (id, run_id, tool_call_id, risk_level, reason, expires_at) VALUES (?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND))", values);
      await execute("UPDATE tool_calls SET status = 'pending_approval', approval_id = ? WHERE id = ?", [id, input.toolCallId]);
    } else {
      await transaction(async (conn) => {
        const [inserted] = await conn.execute(
          "INSERT INTO approvals (id, run_id, tool_call_id, risk_level, reason, expires_at) SELECT ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND) FROM runs WHERE id = ? AND claimed_by = ?",
          [...values, input.runId, owner],
        );
        if ((inserted as ResultSetHeader).affectedRows === 0) throw new LeaseLostError();
        await conn.execute("UPDATE tool_calls SET status = 'pending_approval', approval_id = ? WHERE id = ?", [id, input.toolCallId]);
      });
    }
    const row = await one<{ expires_at: Date }>("SELECT expires_at FROM approvals WHERE id = ?", [id]);
    return { id, expiresAt: new Date(row!.expires_at) };
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
  }): Promise<{ rows: Array<ApprovalRow & { agent_id: string; agent_name: string; tool_key: string | null; tool_args: unknown; attempt: number | null }>; total: number }> {
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
    // r5 contract §2: attempt = the interrupted execution's attempt (tool_calls.attempt) for an interrupted approval,
    // null for a policy approval or a missing call.
    const rows = await query<ApprovalRow & { agent_id: string; agent_name: string; tool_key: string | null; tool_args: unknown; attempt: number | null }>(
      `SELECT a.*, r.agent_id AS agent_id, ag.name AS agent_name, tc.tool_key AS tool_key, tc.args_json AS tool_args,
       CASE WHEN a.reason = 'interrupted' THEN tc.attempt ELSE NULL END AS attempt
       ${from} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { rows, total: Number(counted?.total ?? 0) };
  },
  /** r5 §2.3: marks a still pending approval whose expires_at has passed as expired. Returns whether a row changed. */
  async expireOverdueApproval(id: string): Promise<boolean> {
    const result = await execute("UPDATE approvals SET status = 'expired', decided_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'pending' AND expires_at <= UTC_TIMESTAMP(3)", [id]);
    return result.affectedRows === 1;
  },
  /**
   * r5 §2.6: an approval expired longer than the grace period ago becomes rejected by the system (decided_by NULL, the
   * fixed comment); the Run is then failed with APR-2102. Fenced like every write of a claimed Run.
   */
  async rejectOverdueApproval(id: string, runId: string): Promise<void> {
    const sql = "UPDATE approvals SET status = 'rejected', decided_by = NULL, decided_at = CURRENT_TIMESTAMP(3), comment = '审批过期超过宽限期，系统驳回' WHERE id = ? AND status IN ('pending','expired')";
    const owner = fenceOwnerFor(runId);
    if (owner === null) {
      await execute(sql, [id]);
      return;
    }
    const result = await execute(`${sql} AND ${CHILD_FENCE("approvals")}`, [id, runId, owner]);
    if (result.affectedRows === 0) await assertLeaseOwned(runId, owner);
  },
  /**
   * r5 §2.3 expiry sweep: waiting Runs with an approval past expires_at (pending, or already marked expired) that a tool
   * call still waits on, oldest expires_at first.
   */
  async listRunsWithExpiredApprovals(limit: number): Promise<string[]> {
    const rows = await query<{ id: string }>(
      `SELECT r.id FROM approvals a
       JOIN runs r ON r.id = a.run_id
       JOIN tool_calls tc ON tc.approval_id = a.id AND tc.status = 'pending_approval'
       WHERE r.status = 'waiting_approval' AND a.status IN ('pending','expired') AND a.expires_at < UTC_TIMESTAMP(3)
       GROUP BY r.id ORDER BY MIN(a.expires_at), r.id LIMIT ?`,
      [Math.max(1, Math.floor(limit))],
    );
    return rows.map((row) => row.id);
  },
  /** Marks a still pending approval as expired (no longer operable). Returns whether a row changed. */
  async expirePendingApproval(id: string): Promise<boolean> {
    const result = await execute("UPDATE approvals SET status = 'expired', decided_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'pending'", [id]);
    return result.affectedRows === 1;
  },
  /** r5 §2.3: a pending approval past expires_at (DB clock, UTC) can no longer be decided: 0 rows. */
  async decideApproval(id: string, decision: "approved" | "rejected", decidedBy: string, comment: string): Promise<boolean> {
    const result = await execute(
      "UPDATE approvals SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP(3), comment = ? WHERE id = ? AND status = 'pending' AND expires_at > UTC_TIMESTAMP(3)",
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
  /** Open calls of a Run with their approval's status, reason and (r5 §2.6) whole seconds past expires_at (DB clock). */
  async listOpenToolCalls(runId: string): Promise<Array<ToolCallRow & { approval_status: string | null; approval_reason: string | null; approval_overdue_s: number | null }>> {
    return query(
      `SELECT tc.*, a.status AS approval_status, a.reason AS approval_reason, TIMESTAMPDIFF(SECOND, a.expires_at, UTC_TIMESTAMP(3)) AS approval_overdue_s
       FROM tool_calls tc LEFT JOIN approvals a ON a.id = tc.approval_id
       WHERE tc.run_id = ? AND tc.status IN ('pending','pending_approval','running') ORDER BY tc.created_at, tc.model_step, tc.step_index, tc.id`,
      [runId],
    );
  },
  async timeoutApprovals(runId: string): Promise<number> {
    const owner = fenceOwnerFor(runId);
    const sql = "UPDATE approvals SET status = 'expired', decided_at = CURRENT_TIMESTAMP(3) WHERE run_id = ? AND status = 'pending' AND expires_at <= UTC_TIMESTAMP(3)";
    if (owner === null) return (await execute(sql, [runId])).affectedRows;
    const result = await execute(`${sql} AND ${CHILD_FENCE("approvals")}`, [runId, runId, owner]);
    if (result.affectedRows === 0) await assertLeaseOwned(runId, owner);
    return result.affectedRows;
  },
  async addRunStep(input: { runId: string; type: string; status?: string; summary?: unknown; toolCallId?: string | null }): Promise<string> {
    return (await runsRepo.addRunStepWithSeq(input)).id;
  },
  /** Same as addRunStep, also returning the allocated seq (a call_model step's seq is its tool calls' model_step). */
  async addRunStepWithSeq(input: { runId: string; type: string; status?: string; summary?: unknown; toolCallId?: string | null }): Promise<{ id: string; seq: number }> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await transaction(async (conn) => {
          const [rows] = await conn.execute("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM run_steps WHERE run_id = ? FOR UPDATE", [input.runId]);
          const seq = Number((rows as Array<{ maxSeq: number }>)[0]?.maxSeq ?? 0) + 1;
          const id = ulidWithPrefix("stp");
          const status = input.status ?? "running";
          const values = [id, input.runId, seq, input.type, status, input.toolCallId ?? null, json(input.summary ?? null), status];
          const owner = fenceOwnerFor(input.runId);
          if (owner === null) {
            await conn.execute(
              "INSERT INTO run_steps (id, run_id, seq, type, status, tool_call_id, summary_json, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, IF(? IN ('succeeded','failed'), UTC_TIMESTAMP(3), NULL))",
              values,
            );
            return { id, seq };
          }
          const [inserted] = await conn.execute(
            "INSERT INTO run_steps (id, run_id, seq, type, status, tool_call_id, summary_json, ended_at) SELECT ?, ?, ?, ?, ?, ?, ?, IF(? IN ('succeeded','failed'), UTC_TIMESTAMP(3), NULL) FROM runs WHERE id = ? AND claimed_by = ?",
            [...values, input.runId, owner],
          );
          if ((inserted as ResultSetHeader).affectedRows === 0) throw new LeaseLostError();
          return { id, seq };
        });
      } catch (error) {
        if (!isRetryableWrite(error) || attempt === 4) throw error;
      }
    }
    throw new Error("failed to allocate run step");
  },
  async finishRunStep(id: string, fields: { status: string; errorCode?: string | null; summary?: unknown; inputTokens?: number; outputTokens?: number; costUsd?: number }): Promise<void> {
    const sql = "UPDATE run_steps SET status = ?, error_code = ?, summary_json = COALESCE(?, summary_json), input_tokens = ?, output_tokens = ?, cost_usd = ?, ended_at = UTC_TIMESTAMP(3) WHERE id = ?";
    const params = [fields.status, fields.errorCode ?? null, fields.summary === undefined ? null : json(fields.summary), fields.inputTokens ?? 0, fields.outputTokens ?? 0, fields.costUsd ?? 0, id];
    const fence = activeFence();
    if (fence === null) {
      await execute(sql, params);
      return;
    }
    const result = await execute(`${sql} AND ${CHILD_FENCE("run_steps")}`, [...params, fence.runId, fence.owner]);
    if (result.affectedRows === 0) await assertLeaseOwned(fence.runId, fence.owner);
  },
  async listRunSteps(runId: string): Promise<RunStepRow[]> {
    return query<RunStepRow>("SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq", [runId]);
  },
  async failRunningSteps(runId: string, type: string, errorCode: string): Promise<number> {
    const sql = "UPDATE run_steps SET status = 'failed', error_code = ?, ended_at = UTC_TIMESTAMP(3) WHERE run_id = ? AND type = ? AND status = 'running'";
    const owner = fenceOwnerFor(runId);
    if (owner === null) return (await execute(sql, [errorCode, runId, type])).affectedRows;
    const result = await execute(`${sql} AND ${CHILD_FENCE("run_steps")}`, [errorCode, runId, type, runId, owner]);
    if (result.affectedRows === 0) await assertLeaseOwned(runId, owner);
    return result.affectedRows;
  },
  async addEvent(runId: string, type: string, data: unknown): Promise<number> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await transaction(async (conn) => {
          const [rows] = await conn.execute("SELECT COALESCE(MAX(seq),0) AS maxSeq FROM run_events WHERE run_id = ? FOR UPDATE", [runId]);
          const maxSeq = Number((rows as Array<{ maxSeq: number }>)[0]?.maxSeq ?? 0);
          const seq = maxSeq + 1;
          const owner = fenceOwnerFor(runId);
          if (owner === null) {
            await conn.execute("INSERT INTO run_events (run_id, seq, type, data_json) VALUES (?, ?, ?, ?)", [runId, seq, type, json(data)]);
            return seq;
          }
          const [inserted] = await conn.execute(
            "INSERT INTO run_events (run_id, seq, type, data_json) SELECT ?, ?, ?, ? FROM runs WHERE id = ? AND claimed_by = ?",
            [runId, seq, type, json(data), runId, owner],
          );
          if ((inserted as ResultSetHeader).affectedRows === 0) throw new LeaseLostError();
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
