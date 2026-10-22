import { config } from "@forge/core";

const base = process.env.FORGE_BASE_URL ?? "http://127.0.0.1:3100";
let cookie = "";
let csrf = "";

async function call(path: string, method = "GET", body?: unknown): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (method !== "GET" && csrf) headers["x-csrf-token"] = csrf;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = response.headers.getSetCookie?.()[0];
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const text = await response.text();
  const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

const login = await call("/auth/local/login", "POST", { email: config.FORGE_ADMIN_EMAIL, password: config.FORGE_ADMIN_PASSWORD });
csrf = String(login.csrfToken);

const agents = (await call("/admin/api/agents")).items as Array<Record<string, unknown>>;
const agent = agents.find((item) => item.key === "mcp-agent") ?? agents[0]!;
const detail = await call(`/admin/api/agents/${agent.id}`);
const latest = (detail.versions as Array<Record<string, unknown>>)[0]!;
await call(`/admin/api/agents/${agent.id}/versions`, "POST", { version: `1.0.${Date.now() % 100}`, instructions: latest.instructions, spec: latest.spec_json, publish: true });
console.log("✓ agent new version");

const mcpServers = (await call("/admin/api/mcp")).items as Array<Record<string, unknown>>;
const mcp = mcpServers[0];
if (mcp) {
  await call(`/admin/api/mcp/${mcp.id}`, "PATCH", { name: mcp.name });
  console.log("✓ mcp edit");
}

const skills = (await call("/admin/api/skills")).items as Array<Record<string, unknown>>;
const skill = skills[0];
if (skill) {
  const skillDetail = await call(`/admin/api/skills/${skill.id}`);
  await call(`/admin/api/skills/${skill.id}`, "PATCH", { name: skill.name, description: skill.description });
  await call(`/admin/api/skills/${skill.id}/versions`, "POST", { version: `1.0.${Date.now() % 100}`, content: (skillDetail.versions as Array<Record<string, unknown>>)[0]?.content_md ?? "# Skill", publish: true });
  console.log("✓ skill edit + new version");
}

const providers = (await call("/admin/api/providers")).items as Array<Record<string, unknown>>;
const provider = providers[0];
if (provider) {
  await call(`/admin/api/providers/${provider.id}`, "PATCH", { name: provider.name });
  const model = (provider.models as Array<Record<string, unknown>>)[0];
  if (model) await call(`/admin/api/models/${model.id}`, "PATCH", { displayName: model.displayName });
  console.log("✓ provider/model edit");
}

const apps = (await call("/admin/api/apps")).items as Array<Record<string, unknown>>;
const app = apps[0];
if (app) {
  await call(`/admin/api/apps/${app.id}`, "PATCH", { name: app.name });
  console.log("✓ app edit");
}

const schedules = (await call("/admin/api/schedules")).items as Array<Record<string, unknown>>;
const schedule = schedules[0];
if (schedule) {
  await call(`/admin/api/schedules/${schedule.id}`, "PATCH", { name: schedule.name, cron: schedule.cron, timezone: schedule.timezone, input: schedule.input_json, status: schedule.status });
  console.log("✓ schedule edit");
}

console.log("EDIT SMOKE PASS");
process.exit(0);
