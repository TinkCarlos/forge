import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sessionCookieValue } from "@forge/identity";
import { execute, one, query, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { cleanupRealSessions, realSession, sessionHeaders } from "./helpers/real-session.js";

// P2-12 K-34 (needs a *_test DB): publishing the version that is already published is idempotent. The store uses a
// conditional UPDATE; 0 affected rows -> 200 with the current state, no second agent.publish audit. Two concurrent
// requests for the same version -> both 200, exactly one audit row.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
let app: FastifyInstance;
let headers: Record<string, string> = {};
let agentId = "";
const versions: string[] = [];

const publish = (versionId: string) => app.inject({ method: "POST", url: `/admin/api/agents/${agentId}/publish`, headers, payload: { versionId } });
const audits = async (versionId: string) => (await query("SELECT id FROM audit_logs WHERE action = 'agent.publish' AND resource_id = ?", [versionId])).length;
const published = async () => (await one<{ published_version_id: string | null }>("SELECT published_version_id FROM agents WHERE id = ?", [agentId]))!.published_version_id;
const draft = (v: string) => repos.createAgentVersion({ agentId, version: v, instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "draft", createdBy: ADMIN_ID });

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  const pa = await realSession({ name: "IT pub", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = sessionHeaders(pa, sessionCookieValue(pa));
  agentId = await repos.createAgent({ key: `it-pub-${suffix}`, name: "IT pub", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  for (const v of ["1.0.0", "1.1.0"]) versions.push(await draft(v));
});

afterAll(async () => {
  await execute(`DELETE FROM audit_logs WHERE action = 'agent.publish' AND resource_id IN (${versions.map(() => "?").join(",")})`, versions);
  await execute("UPDATE agents SET published_version_id = NULL, latest_version_id = NULL WHERE id = ?", [agentId]);
  await execute("DELETE FROM agent_versions WHERE agent_id = ?", [agentId]);
  await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  await cleanupRealSessions();
  await app?.close();
});

describe("K-34 publish is idempotent", () => {
  it("two concurrent publishes of the same version -> both 200, one audit, one published version", async () => {
    const [a, b] = await Promise.all([publish(versions[0]!), publish(versions[0]!)]);
    expect([a.statusCode, b.statusCode], `${a.body} ${b.body}`).toEqual([200, 200]);
    expect(await audits(versions[0]!)).toBe(1);
    expect(await published()).toBe(versions[0]);
    expect((await one<{ status: string }>("SELECT status FROM agent_versions WHERE id = ?", [versions[0]]))!.status).toBe("published");
  });

  it("publishing the already published version again -> 200 with the current state, no new audit", async () => {
    const res = await publish(versions[0]!);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, changed: false, publishedVersionId: versions[0] });
    expect(await audits(versions[0]!)).toBe(1);
  });

  it("publishing another version still writes its audit (changed: true)", async () => {
    const res = await publish(versions[1]!);
    expect(res.json()).toMatchObject({ ok: true, changed: true, publishedVersionId: versions[1] });
    expect(await audits(versions[1]!)).toBe(1);
    expect(await published()).toBe(versions[1]);
  });

  it("unknown version -> 404, nothing changes", async () => {
    const res = await publish("01J0000000000000000000ZZZZ");
    expect(res.statusCode).toBe(404);
    expect(await published()).toBe(versions[1]);
  });
});
