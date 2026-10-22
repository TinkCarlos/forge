import { createHmac } from "node:crypto";
import { config, decryptSecret } from "@forge/core";
import { privateNetworkBlocked } from "@forge/capabilities";
import { parseJsonValue, repos, type RunRow } from "@forge/store";

export const WEBHOOK_RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];

export function webhookRetryDelayMs(attemptsAfterFailure: number): number | null {
  const delay = WEBHOOK_RETRY_MS[attemptsAfterFailure - 1];
  return delay ?? null;
}

export function webhookShouldRetry(status: number | null): boolean {
  if (status === null || status === 408 || status === 429 || status >= 500) return true;
  return false;
}

function payloadFor(run: RunRow, status: string): { eventId: string; eventType: string; payload: Record<string, unknown> } {
  const eventType = `run.${status === "succeeded" ? "completed" : status}`;
  return {
    eventId: `evt_${run.id}`,
    eventType,
    payload: {
      id: `evt_${run.id}`,
      type: eventType,
      version: "1",
      createdAt: new Date().toISOString(),
      appId: run.app_id,
      data: {
        runId: run.id,
        status,
        usage: parseJsonValue(run.usage_json, {}),
        resultUrl: `/open/v1/runs/${run.id}/result`,
      },
    },
  };
}

export async function enqueueRunWebhook(run: RunRow, status: string): Promise<void> {
  if (!run.app_id) return;
  const app = await repos.getApiApp(run.app_id);
  if (!app?.webhook_url || !app.webhook_secret_encrypted) return;
  const event = payloadFor(run, status);
  await repos.enqueueWebhook({
    appId: run.app_id,
    eventId: event.eventId,
    eventType: event.eventType,
    payload: event.payload,
  });
}

async function deliverOne(row: Record<string, unknown>, fetchImpl: typeof fetch): Promise<void> {
  const id = String(row.id);
  const attempts = Number(row.attempts ?? 0);
  const claimed = await repos.claimWebhookDelivery(id, attempts);
  if (!claimed) return;
  const attemptNumber = attempts + 1;
  const app = await repos.getApiApp(String(row.app_id));
  if (!app?.webhook_url || !app.webhook_secret_encrypted) {
    await repos.finishWebhookDelivery(id, { status: "failed", errorMessage: "Webhook 未配置" });
    return;
  }
  const url = String(app.webhook_url);
  if (privateNetworkBlocked(url)) {
    await repos.finishWebhookDelivery(id, { status: "failed", errorMessage: "默认禁止 Webhook 访问私网" });
    return;
  }
  const body = JSON.stringify(parseJsonValue(row.payload_json, {}));
  let responseStatus: number | null = null;
  let errorMessage: string | null = null;
  try {
    const secret = decryptSecret(String(app.webhook_secret_encrypted), config.FORGE_MASTER_KEY);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forge-Event-Id": String(row.event_id),
        "X-Forge-Event-Type": String(row.event_type),
        "X-Forge-Delivery-Id": id,
        "X-Forge-Timestamp": String(timestamp),
        "X-Forge-Signature": `t=${timestamp},v1=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    responseStatus = response.status;
    if (response.ok) {
      await repos.finishWebhookDelivery(id, { status: "delivered", responseStatus });
      return;
    }
    errorMessage = `HTTP ${response.status}`.slice(0, 512);
  } catch (error) {
    errorMessage = (error instanceof Error ? error.message : "webhook failed").slice(0, 512);
  }
  const delay = webhookShouldRetry(responseStatus) ? webhookRetryDelayMs(attemptNumber) : null;
  if (delay === null) {
    await repos.finishWebhookDelivery(id, { status: "failed", responseStatus, errorMessage });
    return;
  }
  await repos.scheduleWebhookRetry(id, delay, responseStatus, errorMessage);
}

export async function deliverDueWebhooks(fetchImpl: typeof fetch = fetch): Promise<number> {
  const due = await repos.dueWebhookDeliveries();
  for (const row of due) {
    try {
      await deliverOne(row, fetchImpl);
    } catch (error) {
      console.error("Webhook delivery failed", error);
    }
  }
  return due.length;
}
