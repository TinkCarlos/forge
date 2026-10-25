import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config, hashApiKey } from "@forge/core";
import { maskArgsDeep } from "@forge/governance";
import { createSession, destroySession, sessionCookieValue, type Session } from "@forge/identity";
import { execute, one, repos } from "@forge/store";
import { buildApp } from "../apps/api/src/app.js";
import { MASK01_KEEP, MASK01_VECTORS } from "./helpers/mask01-vectors.js";

// Regression: the raw assistant text stored in `messages` (content_json, never rewritten) leaves the API only through
// maskArgsDeep - the same function as output_json (presentRunOutput). Read paths: GET /admin/api/runs/:id `messages`
// (the only route that returns message rows); /open/v1 and /integration/v1 run detail / result do not return messages,
// only the masked output. The stored row is not touched (no backfill).
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
// MASK-01: fixed values only (no random tokens), so the result does not depend on whether a random token happened to
// contain a digit. The legacy three plus every vector of tests/helpers/mask01-vectors.ts, each checked on its own.
const SK = "sk-abababababababababababababababababab"; // no digit
const BEARER = "Bearer AbCdEfGh-IjKlMnOp_QrStUvWx"; // no digit
const PASSWORD = "pwQwErTyUiOp"; // no digit
const LEGACY_TEXT = `好的。API key: ${SK}\nAuthorization: ${BEARER}\n数据库密码：${PASSWORD}`;
const ASSISTANT_TEXT = [LEGACY_TEXT, ...MASK01_VECTORS.map((v) => v.text), ...MASK01_KEEP].join("\n");
const PLAINTEXT = [SK, BEARER, BEARER.slice("Bearer ".length), PASSWORD, ...MASK01_VECTORS.map((v) => v.secret)];

let app: FastifyInstance;
let session: Session;
let headers: Record<string, string> = {};
let agentId = "";
let versionId = "";
let appId = "";
let openKey = "";
let runId = "";
let messageId = "";
let adminBody = "";
const openBodies: Record<string, string> = {};

function assertNoPlaintext(raw: string): void {
  for (const secret of PLAINTEXT) expect(raw).not.toContain(secret);
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  session = await createSession({ type: "user", id: ADMIN_ID, name: "IT Platform", role: "platform_admin", orgUnitId: ROOT, dataScope: "all" });
  headers = { cookie: `forge_session=${sessionCookieValue(session)}`, "x-csrf-token": session.csrfToken };
  agentId = await repos.createAgent({ key: `it-amsg-${suffix}`, name: "IT assistant mask", ownerOrgUnitId: ROOT, createdBy: ADMIN_ID });
  versionId = await repos.createAgentVersion({ agentId, version: "1.0.0", instructions: "x", spec: { model: { provider: "mock", model: "mock-1" } }, status: "published", createdBy: ADMIN_ID });
  appId = await repos.createApiApp({ key: `it-amsg-${suffix}`, name: "IT assistant mask", scopes: ["runs:read"] });
  openKey = `fsk_${randomBytes(32).toString("base64url")}`;
  await repos.createApiKey({ appId, name: "it-amsg", prefix: openKey.slice(0, 16), keyHash: hashApiKey(openKey, config.API_KEY_PEPPER), scopes: ["runs:read"] });
  const threadId = await repos.createThread({ agentId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID });
  runId = await repos.createRun({ threadId, agentId, agentVersionId: versionId, appId, orgUnitId: ROOT, subjectType: "user", subjectId: ADMIN_ID, input: { text: "hi" }, status: "succeeded" });
  await execute("UPDATE runs SET output_json = ? WHERE id = ?", [JSON.stringify({ text: ASSISTANT_TEXT }), runId]);
  messageId = await repos.addMessage({ threadId, runId, seq: 1, role: "assistant", content: { text: ASSISTANT_TEXT } });
  adminBody = (await app.inject({ method: "GET", url: `/admin/api/runs/${runId}`, headers })).body;
  for (const url of [`/open/v1/runs/${runId}`, `/open/v1/runs/${runId}/result`]) {
    openBodies[url] = (await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${openKey}` } })).body;
  }
});

afterAll(async () => {
  if (session) await destroySession(session.token);
  if (agentId) {
    await execute("DELETE FROM messages WHERE run_id IN (SELECT id FROM runs WHERE agent_id = ?)", [agentId]);
    await execute("DELETE FROM runs WHERE agent_id = ?", [agentId]);
    await execute("DELETE FROM threads WHERE agent_id = ?", [agentId]);
  }
  if (versionId) await execute("DELETE FROM agent_versions WHERE id = ?", [versionId]);
  if (agentId) await execute("DELETE FROM agents WHERE id = ?", [agentId]);
  if (appId) {
    await execute("DELETE FROM api_keys WHERE app_id = ?", [appId]);
    await execute("DELETE FROM api_apps WHERE id = ?", [appId]);
  }
  await app?.close();
});

describe("assistant message text is masked on every read path", () => {
  it("GET /admin/api/runs/:id: raw JSON has no sk- / Bearer / 密码： plaintext; content == maskArgsDeep(stored)", async () => {
    const res = await app.inject({ method: "GET", url: `/admin/api/runs/${runId}`, headers });
    expect(res.statusCode).toBe(200);
    assertNoPlaintext(res.body);
    const body = res.json() as { messages: Array<{ id: string; role: string; content: { text: string } }>; output: unknown };
    const message = body.messages.find((m) => m.id === messageId)!;
    expect(message.role).toBe("assistant");
    expect(message.content).toEqual(maskArgsDeep({ text: ASSISTANT_TEXT }));
    expect(message.content.text).toContain("好的。");
    expect(body.output).toEqual(maskArgsDeep({ text: ASSISTANT_TEXT }));
  });

  it("GET /open/v1/runs/:id and /result: no messages field, output masked the same way", async () => {
    for (const url of [`/open/v1/runs/${runId}`, `/open/v1/runs/${runId}/result`]) {
      const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${openKey}` } });
      expect(res.statusCode).toBe(200);
      assertNoPlaintext(res.body);
      const body = res.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty("messages");
      expect(body.output).toEqual(maskArgsDeep({ text: ASSISTANT_TEXT }));
    }
  });

  it("the stored row keeps the raw text (masking is read-only, no backfill)", async () => {
    const row = await one<{ content_json: { text: string } }>("SELECT content_json FROM messages WHERE id = ?", [messageId]);
    expect(row?.content_json.text).toBe(ASSISTANT_TEXT);
  });

  describe("MASK-01 vectors, one by one (with and without a digit)", () => {
    it.each(MASK01_VECTORS)("admin GET /admin/api/runs/:id hides $name", ({ secret }) => {
      expect(adminBody.length).toBeGreaterThan(0);
      expect(adminBody).not.toContain(secret);
    });
    it.each(MASK01_VECTORS)("open GET /open/v1/runs/:id and /result hide $name", ({ secret }) => {
      for (const body of Object.values(openBodies)) {
        expect(body.length).toBeGreaterThan(0);
        expect(body).not.toContain(secret);
      }
    });
    it.each(MASK01_KEEP)("admin and open keep ordinary text unchanged: %s", (text) => {
      const admin = JSON.parse(adminBody) as { messages: Array<{ id: string; content: { text: string } }>; output: { text: string } };
      expect(admin.messages.find((m) => m.id === messageId)!.content.text.split("\n")).toContain(text);
      expect(admin.output.text.split("\n")).toContain(text);
      for (const body of Object.values(openBodies)) {
        expect((JSON.parse(body) as { output: { text: string } }).output.text.split("\n")).toContain(text);
      }
    });
  });
});
