import { config } from "@forge/core";
import { repos } from "@forge/store";

const base = process.env.FORGE_BASE_URL ?? "http://127.0.0.1:3100";
let cookie = "";
let csrf = "";

class SmokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeError";
  }
}

let lastHeaders: Headers | null = null;

async function call(path: string, options: { method?: string; body?: unknown; bearer?: string; headers?: Record<string, string> } = {}): Promise<Record<string, unknown>> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };
  if (cookie && !options.bearer) headers.Cookie = cookie;
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
  if (method !== "GET" && csrf && !options.bearer) headers["x-csrf-token"] = csrf;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  lastHeaders = response.headers;
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) throw new SmokeError(`${method} ${path} -> ${response.status}: ${JSON.stringify(payload.error ?? payload)}`);
  return payload;
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new SmokeError(message);
}

function assertIncludes(text: string, needle: string, message: string): void {
  assert(text.includes(needle), `${message}: expected to include ${needle}`);
}

async function waitRun(path: (id: string) => string, id: string, options: { bearer?: string } = {}): Promise<Record<string, unknown>> {
  const terminal = ["succeeded", "failed", "cancelled", "budget_exhausted"];
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const run = await call(path(id), { bearer: options.bearer });
    if (terminal.includes(String(run.status))) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new SmokeError(`run ${id} did not finish`);
}

async function waitApprovalRun(id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const run = await call(`/admin/api/runs/${id}`);
    if (run.status === "waiting_approval") return run;
    if (["succeeded", "failed", "cancelled"].includes(String(run.status))) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new SmokeError(`run ${id} never waited for approval`);
}

async function readEvents(runId: string, lastEventId?: string): Promise<Array<{ id: string; event: string }>> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (cookie) headers.Cookie = cookie;
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;
  const response = await fetch(`${base}/admin/api/runs/${runId}/events`, { headers });
  const text = await response.text();
  if (!response.ok) throw new SmokeError(`SSE ${runId} -> ${response.status}: ${text.slice(0, 200)}`);
  const events: Array<{ id: string; event: string }> = [];
  for (const part of text.split(/\r?\n\r?\n/)) {
    let id = "";
    let event = "";
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      if (line.startsWith("event:")) event = line.slice(6).trim();
    }
    if (id && event) events.push({ id, event });
  }
  return events;
}

async function findByKey(listPath: string, key: string): Promise<Record<string, unknown> | null> {
  const result = await call(listPath);
  return ((result.items as unknown[]) ?? []).map((item) => item as Record<string, unknown>).find((item) => item.key === key) ?? null;
}

async function main(): Promise<void> {
  const login = await call("/auth/local/login", { method: "POST", body: { email: config.FORGE_ADMIN_EMAIL, password: config.FORGE_ADMIN_PASSWORD } });
  csrf = String(login.csrfToken);
  console.log("✓ local login", login.user && (login.user as Record<string, unknown>).name);

  // MCP
  if (!(await findByKey("/admin/api/mcp", "demo-mcp"))) {
    await call("/admin/api/mcp", { method: "POST", body: { key: "demo-mcp", name: "Demo MCP", url: "http://127.0.0.1:8090/mcp", headers: {} } });
  }
  await call("/admin/api/mcp", { method: "POST", body: { key: "demo-mcp", name: "Demo MCP", url: "http://127.0.0.1:8090/mcp", headers: {} } }).catch(() => null);
  const mcpServers = await call("/admin/api/mcp");
  const mcp = (mcpServers.items as Array<Record<string, unknown>>).find((server) => server.key === "demo-mcp") as Record<string, unknown>;
  assert(mcp, "demo-mcp missing");
  assert((mcp.tools as unknown[]).length >= 2, "demo-mcp tools not discovered");
  console.log("✓ MCP discovery", (mcp.tools as unknown[]).length);

  // OpenAPI tool source
  const spec = await (await fetch("http://127.0.0.1:8090/api/openapi.json")).json();
  await call("/admin/api/tool-sources/import", { method: "POST", body: { key: "demo-http", name: "Demo HTTP", baseUrl: "http://127.0.0.1:8090/api", spec } }).catch(() => null);
  console.log("✓ OpenAPI imported");

  // Agent
  if (!(await findByKey("/admin/api/agents", "mcp-agent"))) {
    await call("/admin/api/agents", {
      method: "POST",
      body: {
        key: "mcp-agent",
        name: "MCP 演示 Agent",
        instructions: "按用户指令调用工具；不要编造工具结果。",
        publish: true,
        spec: {
          model: { provider: "mock", model: "mock-1", temperature: 0 },
          skills: ["forge-demo-skill"],
          toolsets: [
            { builtin: ["current_time"] },
            { mcp: "demo-mcp", allow: ["get_time", "risky_submit"] },
            { openapi: "demo-http", allow: ["get_hello"] },
          ],
          limits: { maxSteps: 8, maxCostUsd: 1 },
          approval: { timeoutSeconds: 600 },
        },
      },
    });
  }
  const agent = (await findByKey("/admin/api/agents", "mcp-agent")) as Record<string, unknown>;
  assert(agent && agent.id, "mcp-agent missing");
  await call(`/admin/api/agents/${agent.id}`, { method: "PATCH", body: { apiEnabled: true } });

  // Low risk tool run
  const low = await call(`/admin/api/agents/${agent.id}/run`, { method: "POST", body: { input: { text: "[use:mcp_demo-mcp_get_time]" } } });
  const lowRun = await waitRun((id) => `/admin/api/runs/${id}`, String(low.runId));
  assert(lowRun.status === "succeeded", `low risk run failed: ${JSON.stringify(lowRun.output)}`);
  console.log("✓ MCP tool run succeeded");

  // High risk approval
  const high = await call(`/admin/api/agents/${agent.id}/run`, { method: "POST", body: { input: { text: "[use:mcp_demo-mcp_risky_submit] 提交测试" } } });
  const waiting = await waitApprovalRun(String(high.runId));
  assert(waiting.status === "waiting_approval", `high risk run did not wait: ${waiting.status}`);
  const approvals = await call("/admin/api/approvals");
  const approval = (approvals.items as Array<Record<string, unknown>>).find((item) => item.run_id === high.runId) as Record<string, unknown>;
  assert(approval, "approval not found");
  await call(`/admin/api/approvals/${approval.id}/decide`, { method: "POST", body: { decision: "approved", comment: "smoke" } });
  const highRun = await waitRun((id) => `/admin/api/runs/${id}`, String(high.runId));
  assert(highRun.status === "succeeded", `high risk run failed after approval: ${JSON.stringify(highRun.output)}`);
  console.log("✓ approval run succeeded");

  // OpenAPI run
  const openApiRun = await call(`/admin/api/agents/${agent.id}/run`, { method: "POST", body: { input: { text: "[use:openapi_demo-http_get_hello]" } } });
  const openApiResult = await waitRun((id) => `/admin/api/runs/${id}`, String(openApiRun.runId));
  assert(openApiResult.status === "succeeded", "openapi run failed");
  console.log("✓ OpenAPI tool run succeeded");

  // Schedule
  const schedules = await call("/admin/api/schedules");
  let schedule = (schedules.items as Array<Record<string, unknown>>).find((item) => item.key === "smoke-schedule");
  if (!schedule) {
    await call("/admin/api/schedules", {
      method: "POST",
      body: { key: "smoke-schedule", name: "Smoke Schedule", agentId: agent.id, cron: "0 * * * *", timezone: "Asia/Shanghai", input: { text: "[use:mcp_demo-mcp_get_time]" }, enabled: true },
    });
    const refreshed = await call("/admin/api/schedules");
    schedule = (refreshed.items as Array<Record<string, unknown>>).find((item) => item.key === "smoke-schedule");
  }
  const manual = await call(`/admin/api/schedules/${schedule!.id}/run`, { method: "POST", body: {} });
  const scheduledRun = await waitRun((id) => `/admin/api/runs/${id}`, String(manual.runId));
  assert(scheduledRun.status === "succeeded", "schedule manual run failed");
  console.log("✓ schedule manual run succeeded");

  // Open platform
  let app = await findByKey("/admin/api/apps", "smoke-app");
  if (!app) {
    app = (await call("/admin/api/apps", { method: "POST", body: { key: "smoke-app", name: "Smoke App", scopes: ["agents:read", "runs:create", "runs:read", "runs:cancel"] } })) as Record<string, unknown>;
  }
  const keyResult = await call(`/admin/api/apps/${app.id}/keys`, { method: "POST", body: { name: "smoke" } });
  const apiKey = String(keyResult.key);
  const openAgents = await call("/open/v1/agents", { bearer: apiKey });
  assert(((openAgents.items as unknown[]) ?? []).some((item) => (item as Record<string, unknown>).key === "mcp-agent"), "mcp-agent not in open catalog");
  const openRun = await call(`/open/v1/agents/mcp-agent/runs`, { method: "POST", bearer: apiKey, body: { input: { text: "[use:mcp_demo-mcp_get_time]" } } });
  const openFinished = await waitRun((id) => `/open/v1/runs/${id}`, String(openRun.runId), { bearer: apiKey });
  assert(openFinished.status === "succeeded", "open api run failed");
  console.log("✓ open platform run succeeded");

  const idempotencyKey = `smoke-${Date.now()}`;
  const idemBody = { input: { text: "idempotent hello" } };
  const firstIdem = await call("/open/v1/agents/mcp-agent/runs", { method: "POST", bearer: apiKey, headers: { "Idempotency-Key": idempotencyKey }, body: idemBody });
  const replayIdem = await call("/open/v1/agents/mcp-agent/runs", { method: "POST", bearer: apiKey, headers: { "Idempotency-Key": idempotencyKey }, body: idemBody });
  assert(replayIdem.runId === firstIdem.runId, "idempotency replay created another run");
  assert(lastHeaders?.get("idempotency-replayed") === "true", "missing Idempotency-Replayed header");
  let conflicted = false;
  try {
    await call("/open/v1/agents/mcp-agent/runs", { method: "POST", bearer: apiKey, headers: { "Idempotency-Key": idempotencyKey }, body: { input: { text: "different body" } } });
  } catch (error) {
    conflicted = String(error).includes("409");
  }
  assert(conflicted, "different body with the same Idempotency-Key was accepted");
  console.log("✓ idempotency key replay and conflict");

  const invoked = await call("/open/v1/agents/mcp-agent/invoke?wait=20", { method: "POST", bearer: apiKey, body: { input: { text: "同步你好" } } });
  assert(invoked.status === "succeeded", `invoke did not finish: ${JSON.stringify(invoked)}`);
  assert(invoked.threadId, "invoke did not return a thread");
  const followUp = await call("/open/v1/agents/mcp-agent/invoke?wait=20", {
    method: "POST",
    bearer: apiKey,
    body: { threadId: invoked.threadId, input: { text: "继续这一轮" } },
  });
  assert(followUp.status === "succeeded" && followUp.threadId === invoked.threadId, `thread follow-up failed: ${JSON.stringify(followUp)}`);
  console.log("✓ synchronous invoke and thread follow-up");

  // Data permission
  let user = (await call("/admin/api/users")).items as Array<Record<string, unknown>>;
  let target = user.find((item) => item.email === "self-user@forge.local");
  if (!target) {
    await call("/admin/api/users", { method: "POST", body: { email: "self-user@forge.local", username: "self-user", displayName: "Self User", password: "password12345", role: "user", dataScope: "self" } });
    user = (await call("/admin/api/users")).items as Array<Record<string, unknown>>;
    target = user.find((item) => item.email === "self-user@forge.local");
  }
  assert(target, "self-user missing");
  const adminRuns = await call("/admin/api/runs?limit=100");
  const adminCount = (adminRuns.items as unknown[]).length;

  const selfLogin = await call("/auth/local/login", { method: "POST", body: { email: "self-user@forge.local", password: "password12345" } });
  const selfCsrf = String(selfLogin.csrfToken);
  const selfCookie = cookie;
  const selfAgentRun = await (async () => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Cookie: selfCookie, "x-csrf-token": selfCsrf };
    const response = await fetch(`${base}/admin/api/agents/${agent!.id}/run`, { method: "POST", headers, body: JSON.stringify({ input: { text: "[use:mcp_demo-mcp_get_time]" } }) });
    return (await response.json()) as Record<string, unknown>;
  })();
  const selfRun = await waitRun((id) => `/admin/api/runs/${id}`, String(selfAgentRun.runId));
  assert(selfRun.status === "succeeded", "self-user run failed");
  const selfRuns = await call("/admin/api/runs?limit=100");
  const selfCount = (selfRuns.items as unknown[]).length;
  assert(selfCount < adminCount, `data scope self should see fewer runs (${selfCount} >= ${adminCount})`);
  console.log("✓ data scope enforced");

  const adminAgain = await call("/auth/local/login", { method: "POST", body: { email: config.FORGE_ADMIN_EMAIL, password: config.FORGE_ADMIN_PASSWORD } });
  csrf = String(adminAgain.csrfToken);

  // Package install
  const packKey = `smoke-pack-${Date.now()}`;
  const plugin = await call("/admin/api/plugins/install", {
    method: "POST",
    body: {
      key: packKey,
      version: "1.0.0",
      type: "mixed",
      name: "Smoke Pack",
      resources: {
        skills: [{ key: `smoke-skill-${Date.now()}`, name: "Smoke Skill", description: "pack", content: "# Smoke\n" }],
        agents: [{ key: `smoke-agent-${Date.now()}`, name: "Smoke Agent", instructions: "回答简洁。", spec: { model: { provider: "mock", model: "mock-1" }, toolsets: [{ builtin: ["current_time"] }], limits: { maxSteps: 2 } } }],
      },
    },
  });
  assert(plugin.id, "plugin install failed");
  console.log("✓ package install succeeded");

  const audit = await call("/admin/api/audit?limit=10");
  assert(((audit.items as unknown[]) ?? []).length > 0, "audit log empty");
  console.log("✓ audit log written");

  const streamed = await call(`/admin/api/agents/${agent.id}/run`, { method: "POST", body: { input: { text: "请介绍 Forge 运行时" } } });
  const streamedRun = await waitRun((id) => `/admin/api/runs/${id}`, String(streamed.runId));
  assert(streamedRun.status === "succeeded", "stream run failed");
  const liveEvents = await readEvents(String(streamed.runId));
  const deltas = liveEvents.filter((event) => event.event === "message.delta");
  assert(deltas.length >= 2, `expected multiple message.delta events, got ${deltas.length}`);
  const seqs = deltas.map((event) => Number(event.id));
  assert(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!), "delta sequence is not increasing");
  const replay = await readEvents(String(streamed.runId), String(seqs[0]));
  assert(!replay.some((event) => Number(event.id) === seqs[0]), "Last-Event-ID replayed the first delta");
  assert(replay.some((event) => Number(event.id) > seqs[0]!), "Last-Event-ID dropped later events");
  console.log("✓ SSE deltas resume after Last-Event-ID");

  const versionId = String(agent.publishedVersionId ?? "");
  assert(versionId, "mcp-agent has no published version");
  const threadId = await repos.createThread({
    agentId: String(agent.id),
    orgUnitId: null,
    subjectType: "user",
    subjectId: "01J00000000000000000000001",
    title: "lease-resume",
  });
  const stuckId = await repos.createRun({
    threadId,
    agentId: String(agent.id),
    agentVersionId: versionId,
    orgUnitId: null,
    subjectType: "user",
    subjectId: "01J00000000000000000000001",
    input: { text: "[use:current_time]" },
    status: "running",
    claimedBy: "smoke-setup",
    leaseSeconds: 300,
  });
  const keptToolId = await repos.addToolCall({
    runId: stuckId,
    toolKey: "current_time",
    args: {},
    risk: "low",
    status: "succeeded",
    idempotencyKey: `${stuckId}:kept`,
  });
  await repos.addMessage({ threadId, runId: stuckId, seq: 1, role: "user", content: { text: "[use:current_time]" } });
  await repos.addMessage({
    threadId,
    runId: stuckId,
    seq: 2,
    role: "assistant",
    content: { text: "", tool_calls: [{ id: keptToolId, type: "function", function: { name: "current_time", arguments: "{}" } }] },
  });
  await repos.addMessage({ threadId, runId: stuckId, seq: 3, role: "tool", content: { text: "ok", tool_call_id: keptToolId, name: "current_time" } });
  await repos.expireRunLease(stuckId);
  const resumed = await waitRun((id) => `/admin/api/runs/${id}`, stuckId);
  assert(resumed.status === "succeeded", `expired lease was not resumed: ${JSON.stringify(resumed)}`);
  const resumedDetail = await call(`/admin/api/runs/${stuckId}`);
  assert(((resumedDetail.toolCalls as unknown[]) ?? []).length === 1, "resumed run repeated a succeeded tool");
  console.log("✓ expired lease resumed without repeating the tool");

  console.log("\nSMOKE PASS: Forge agent framework is usable end-to-end");
  process.exit(0);
}

main().catch((error) => {
  console.error("SMOKE FAILED", error);
  process.exit(1);
});
