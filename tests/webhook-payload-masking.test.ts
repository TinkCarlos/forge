import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { config, encryptSecret, setOutboundResolver } from "@forge/core";
import { deliverDueWebhooks } from "@forge/runtime";
import { execute, one, parseJsonValue, repos, type RunRow } from "@forge/store";
import { enqueueRunWebhook } from "../packages/runtime/src/webhook";

// P1 webhook payload (needs a *_test DB): whenever a webhook payload is stored, sent or logged it goes through the
// run-output mask (maskArgsDeep). Rows queued before the fix are masked when sent (no backfill); the HMAC signature
// covers the body that is actually sent.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const SECRETS = ["tok-SEKRET-1", "abcDEF1234567890xyz", "pw-SEKRET-8", "tok-SEKRET-9"];
let appId = "";
const leaks = (text: string) => SECRETS.filter((s) => text.includes(s));

beforeAll(async () => {
  appId = await repos.createApiApp({
    key: `it-whm-${suffix}`, name: "IT whm", ownerOrgUnitId: ROOT, scopes: ["runs:create"],
    webhookUrl: "https://example.com/hooks/whm", webhookSecretEncrypted: encryptSecret("whsec_whm", config.FORGE_MASTER_KEY), createdBy: ADMIN_ID,
  });
  setOutboundResolver(async (host) => (host === "example.com" ? [{ address: "93.184.215.14", family: 4 }] : []));
});

afterAll(async () => {
  setOutboundResolver(null);
  if (appId) {
    await execute("DELETE FROM webhook_deliveries WHERE app_id = ?", [appId]);
    await execute("DELETE FROM api_apps WHERE id = ?", [appId]);
  }
});

describe("P1 webhook payload masking", () => {
  it("a run webhook is stored masked", async () => {
    const run = { id: `run_whm_${suffix}`, app_id: appId, usage_json: { inputTokens: 3, access_token: SECRETS[3], note: `password=${SECRETS[2]} ok` } } as unknown as RunRow;
    await enqueueRunWebhook(run, "succeeded");
    const row = await one<{ payload_json: unknown }>("SELECT payload_json FROM webhook_deliveries WHERE app_id = ? AND event_id = ?", [appId, `evt_${run.id}`]);
    expect(row).toBeTruthy();
    const stored = JSON.stringify(parseJsonValue(row!.payload_json, {}));
    expect(leaks(stored)).toEqual([]);
    expect(stored).toContain('"inputTokens":3');
    expect(stored).toContain("password=***");
    await execute("DELETE FROM webhook_deliveries WHERE app_id = ? AND event_id = ?", [appId, `evt_${run.id}`]);
  });

  it("a legacy queued row with clear text is masked when sent; the signature matches the sent body", async () => {
    const eventId = `evt_whm_legacy_${suffix}`;
    await repos.enqueueWebhook({ appId, eventId, eventType: "run.completed", payload: { id: eventId, data: { access_token: SECRETS[0], note: `Bearer ${SECRETS[1]}`, runId: "run_x" } } });
    const sent: Array<{ body: string; sig: string; ts: string }> = [];
    await deliverDueWebhooks(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      if (headers["X-Forge-Event-Id"] === eventId) sent.push({ body: String(init?.body), sig: headers["X-Forge-Signature"]!, ts: headers["X-Forge-Timestamp"]! });
      return new Response("ok", { status: 200 });
    });
    expect(sent).toHaveLength(1);
    expect(leaks(sent[0]!.body)).toEqual([]);
    expect(JSON.parse(sent[0]!.body)).toEqual({ id: eventId, data: { access_token: "***", note: "***", runId: "run_x" } });
    const expected = createHmac("sha256", "whsec_whm").update(`${sent[0]!.ts}.${sent[0]!.body}`).digest("hex");
    expect(sent[0]!.sig).toBe(`t=${sent[0]!.ts},v1=${expected}`);
  });
});
