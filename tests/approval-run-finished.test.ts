import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, one, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// I-APR-38: deciding an approval whose Run already ended -> 409 RUN-7005, the approval becomes expired (not
// operable any more), no approval.decide audit, the Run is not resumed. I-APR-37: deciding an already decided
// approval -> 409 APR-2104.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ADMIN_ID = "01J00000000000000000000001";
const ROOT = "01J00000000000000000000000";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";

async function approvalFor(status: string): Promise<{ runId: string; approvalId: string }> {
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  const runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "x" }, status });
  const toolCallId = await repos.addToolCall({ runId, toolKey: "mail.send", args: { to: "a@example.com" }, risk: "high", status: "pending" });
  return { runId, approvalId: (await repos.addApproval({ runId, toolCallId, risk: "high", timeoutSeconds: 3600 })).id };
}
const decide = (id: string, decision: string) => app.inject({ method: "POST", url: `/admin/api/approvals/${id}/decide`, headers, payload: { decision } });
const approvalStatus = async (id: string) => (await one<{ status: string }>("SELECT status FROM approvals WHERE id = ?", [id]))!.status;
const audits = async (id: string) => (await query("SELECT id FROM audit_logs WHERE outcome = 'success' AND action = 'approval.decide' AND resource_id = ?", [id])).length;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  agentId = await repos.createAgent({ key: `it-arf-${suffix}`, name: "IT arf", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID }, { expectedRevision: "system" });
});

afterAll(async () => {
  if (agentId) {
    await execute("DELETE a FROM audit_logs a JOIN approvals p ON p.id = a.resource_id JOIN runs r ON r.id = p.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE p FROM approvals p JOIN runs r ON r.id = p.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE t FROM tool_calls t JOIN runs r ON r.id = t.run_id WHERE r.agent_id = ?", [agentId]);
    await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  }
  await cleanupRealSessions();
  await app?.close();
});

describe("decide on a finished Run (I-APR-38)", () => {
  for (const status of ["succeeded", "failed", "cancelled", "budget_exhausted"]) {
    for (const decision of ["approved", "rejected"]) {
      it(`run ${status}, ${decision} -> 409 RUN-7005, approval expired, no audit, run unchanged`, async () => {
        const { runId, approvalId } = await approvalFor(status);
        const res = await decide(approvalId, decision);
        expect(res.statusCode, res.body).toBe(409);
        expect((res.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: "RUN-7005", message: "Run 已结束，审批不可操作" });
        expect(await approvalStatus(approvalId)).toBe("expired");
        expect(await audits(approvalId)).toBe(0);
        expect((await repos.getRun(runId))!.status).toBe(status);
        // P3-02: a second attempt finds the approval already expired -> 409 APR-2104 (approval state wins over Run state).
        const again = await decide(approvalId, "approved");
        expect([again.statusCode, (again.json() as { error: { code: string } }).error.code]).toEqual([409, "APR-2104"]);
        expect(await approvalStatus(approvalId)).toBe("expired");
      });
    }
  }

  it("invalid decision on a finished run is still 400 (validated first), approval untouched", async () => {
    const { approvalId } = await approvalFor("succeeded");
    expect((await decide(approvalId, "maybe")).statusCode).toBe(400);
    expect(await approvalStatus(approvalId)).toBe("pending");
  });
});

describe("P3-02: an approval that is no longer pending -> 409 APR-2104 whatever the Run status", () => {
  for (const [approval, run] of [["rejected", "succeeded"], ["approved", "failed"], ["expired", "cancelled"], ["rejected", "budget_exhausted"], ["expired", "waiting_approval"]] as const) {
    it(`approval ${approval}, run ${run} -> APR-2104, approval and run unchanged, no audit`, async () => {
      const { runId, approvalId } = await approvalFor(run);
      await execute("UPDATE approvals SET status = ? WHERE id = ?", [approval, approvalId]);
      const res = await decide(approvalId, "approved");
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: "APR-2104", message: "审批已处理或已过期" });
      expect(await approvalStatus(approvalId)).toBe(approval);
      expect(await audits(approvalId)).toBe(0);
      expect((await repos.getRun(runId))!.status).toBe(run);
    });
  }
});

describe("already decided approval (I-APR-37)", () => {
  it("rejected then approved -> 409 APR-2104, stays rejected", async () => {
    const { approvalId } = await approvalFor("waiting_approval");
    const first = await decide(approvalId, "rejected");
    expect(first.statusCode, first.body).toBe(200);
    const again = await decide(approvalId, "approved");
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe("APR-2104");
    expect(await approvalStatus(approvalId)).toBe("rejected");
  });
});
