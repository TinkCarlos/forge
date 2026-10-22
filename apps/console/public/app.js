const state = {
  session: null,
  tab: "dashboard",
  agents: [],
  providers: [],
  runs: [],
  schedules: [],
  apps: [],
  users: [],
  approvals: [],
  mcp: [],
  skills: [],
  plugins: [],
  toolSources: [],
  sso: null,
  eventSource: null,
};

const $ = (selector) => document.querySelector(selector);
const navGroups = [
  { label: "概览", items: [{ id: "dashboard", label: "总览", icon: "D" }] },
  {
    label: "构建",
    items: [
      { id: "agents", label: "Agents", icon: "A" },
      { id: "models", label: "模型", icon: "M" },
      { id: "mcp", label: "MCP 服务", icon: "C" },
      { id: "skills", label: "Skills", icon: "S" },
      { id: "tools", label: "工具源", icon: "T" },
      { id: "packages", label: "能力包", icon: "P" },
    ],
  },
  {
    label: "运行",
    items: [
      { id: "runs", label: "运行中心", icon: "R" },
      { id: "approvals", label: "审批中心", icon: "!" },
      { id: "schedules", label: "定时任务", icon: "H" },
    ],
  },
  {
    label: "开放平台",
    items: [{ id: "apps", label: "应用与密钥", icon: "K" }],
  },
  {
    label: "治理",
    items: [
      { id: "users", label: "用户与权限", icon: "U" },
      { id: "sso", label: "SSO / Connector", icon: "I" },
    ],
  },
];
const tabMeta = {
  dashboard: ["总览", "运行状态、成本与待审批"],
  agents: ["Agents", "创建、发布、开放 API 与试运行"],
  models: ["模型", "自定义 OpenAI-compatible Provider 与模型目录"],
  mcp: ["MCP 服务", "添加远程 MCP，发现工具并测试"],
  skills: ["Skills", "安装、编写与发布技能"],
  tools: ["工具源", "导入 OpenAPI 并生成可调用工具"],
  packages: ["能力包", "以声明式 JSON 安装 Agent / Skill / MCP / Provider"],
  runs: ["运行中心", "查看执行日志、工具调用与实时事件"],
  approvals: ["审批中心", "处理高风险工具调用"],
  schedules: ["定时任务", "按 Cron 以服务身份运行（普通用户权限，数据范围为创建者所在部门）"],
  apps: ["应用与密钥", "开放平台 API Key、配额与 Webhook"],
  users: ["用户与权限", "功能角色与数据范围"],
  sso: ["SSO / Connector", "统一登录与 Agent 平台接入状态"],
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function json(value) {
  return esc(JSON.stringify(value ?? null, null, 2));
}

function fmt(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function toast(message, kind = "ok") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 4200);
}

async function api(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD" && state.session?.csrfToken) {
    headers["x-csrf-token"] = state.session.csrfToken;
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (response.status === 401) {
    showLogin();
    throw new Error(payload?.error?.message ?? "登录已过期");
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `请求失败 (${response.status})`);
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function showLogin() {
  state.session = null;
  $("#app-view").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
}

function showApp() {
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
}

async function init() {
  try {
    const auth = await api("/auth/config");
    $("#sso-login").classList.toggle("hidden", !auth.oidcConfigured);
    if (!auth.localLogin) {
      $("#login-form").classList.add("hidden");
      $("#login-hint").textContent = "请使用统一 SSO 登录。";
    }
  } catch {
    // ignore config errors
  }
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    try {
      state.session = await api("/auth/local/login", {
        method: "POST",
        body: { email: data.get("email"), password: data.get("password") },
      });
      await enterApp();
    } catch (error) {
      toast(error.message, "error");
    }
  });
  $("#logout").addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    showLogin();
  });
  $("#refresh").addEventListener("click", () => renderCurrent());
  window.addEventListener("hashchange", () => switchTab(location.hash.slice(1) || "dashboard"));
  try {
    state.session = await api("/auth/session");
    await enterApp();
  } catch {
    showLogin();
  }
}

function setApiStatus(ok) {
  const el = $("#api-status");
  if (!el) return;
  el.classList.toggle("down", !ok);
  el.querySelector(".status-text").textContent = ok ? "API 正常" : "API 异常";
  el.title = ok ? "API 与数据库就绪" : "API 或数据库不可用，请联系运维";
  $("#api-banner")?.classList.toggle("hidden", ok);
}

async function checkHealth() {
  try {
    const response = await fetch("/readyz", { cache: "no-store", credentials: "same-origin" });
    const body = await response.json().catch(() => null);
    setApiStatus(response.ok && body?.database !== false);
  } catch {
    setApiStatus(false);
  }
}

async function enterApp() {
  showApp();
  checkHealth();
  clearInterval(checkHealth.timer);
  checkHealth.timer = setInterval(checkHealth, 30000);
  $("#user-chip").innerHTML = `<strong>${esc(state.session.user.name)}</strong><span>${esc(state.session.user.role)} · ${esc(state.session.user.dataScope)}</span>`;
  renderNav();
  await switchTab(location.hash.slice(1) || "dashboard");
}

function renderNav() {
  const nav = $("#nav");
  nav.innerHTML = navGroups
    .map(
      (group) => `
      <div class="nav-section">${group.label}</div>
      ${group.items
        .map(
          (item) => `<button class="nav-item ${state.tab === item.id ? "active" : ""}" onclick="app.switchTab('${item.id}')">
            <span class="nav-icon">${item.icon}</span><span>${item.label}</span>
          </button>`,
        )
        .join("")}
    `,
    )
    .join("");
}

async function switchTab(tab) {
  if (!tabMeta[tab]) tab = "dashboard";
  state.tab = tab;
  location.hash = tab;
  $("#page-title").textContent = tabMeta[tab][0];
  $("#page-subtitle").textContent = tabMeta[tab][1];
  renderNav();
  $("#content").innerHTML = `<div class="card"><div class="card-body muted">加载中…</div></div>`;
  try {
    await renderCurrent();
  } catch (error) {
    $("#content").innerHTML = errorCard(error);
  }
}

async function renderCurrent() {
  closeStream();
  switch (state.tab) {
    case "dashboard": return renderDashboard();
    case "agents": return renderAgents();
    case "models": return renderModels();
    case "mcp": return renderMcp();
    case "skills": return renderSkills();
    case "tools": return renderTools();
    case "packages": return renderPackages();
    case "runs": return renderRuns();
    case "approvals": return renderApprovals();
    case "schedules": return renderSchedules();
    case "apps": return renderApps();
    case "users": return renderUsers();
    case "sso": return renderSso();
    default: return renderDashboard();
  }
}

function errorCard(error) {
  return `<div class="card"><div class="card-body"><strong>加载失败</strong><p class="muted">${esc(error.message)}</p><button class="btn ghost" onclick="app.renderCurrent()">重试</button></div></div>`;
}

function empty(title, text, action = "") {
  return `<div class="empty"><strong>${esc(title)}</strong><span>${esc(text)}</span>${action ? `<div style="margin-top:14px">${action}</div>` : ""}</div>`;
}

function statusPill(status) {
  const map = {
    active: "ok", succeeded: "ok", approved: "ok",
    queued: "info", running: "info", waiting_approval: "warn", pending: "warn", disabled: "warn",
    failed: "bad", rejected: "bad", cancelled: "bad", expired: "bad", budget_exhausted: "bad",
  };
  return `<span class="pill ${map[status] ?? ""}">${esc(status)}</span>`;
}

async function renderDashboard() {
  const data = await api("/admin/api/dashboard");
  const runs = await api("/admin/api/runs?limit=6");
  const byStatus = data.runsByStatus ?? {};
  $("#content").innerHTML = `
    <div class="grid cols-4">
      ${stat("今日运行", data.runsToday, "当前实例")}
      ${stat("Agents", data.agents, "已配置")}
      ${stat("待审批", data.pendingApprovals, "需要处理")}
      ${stat("运行中", (byStatus.running ?? 0) + (byStatus.queued ?? 0), "队列 + 执行中")}
    </div>
    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><div><h3>快速开始</h3><p class="muted">离线 Mock 模型已就绪</p></div></div>
        <div class="card-body actions">
          <button class="btn primary" onclick="app.openAgentCreate()">新建 Agent</button>
          <button class="btn ghost" onclick="app.openProviderCreate()">接入自定义模型</button>
          <button class="btn ghost" onclick="app.switchTab('packages')">安装能力包</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>运行状态</h3><p class="muted">按状态统计</p></div></div>
        <div class="card-body">
          ${Object.entries(byStatus).length ? Object.entries(byStatus).map(([key, value]) => `<div style="display:flex;justify-content:space-between;padding:5px 0"><span>${statusPill(key)}</span><strong>${value}</strong></div>`).join("") : `<span class="muted">暂无运行</span>`}
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>最近运行</h3><p class="muted">点开查看消息与工具调用</p></div><button class="btn ghost small" onclick="app.switchTab('runs')">全部</button></div>
      ${runs.items?.length ? `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>状态</th><th>成本</th><th>时间</th><th></th></tr></thead><tbody>
        ${runs.items.map((run) => `<tr><td class="mono">${esc(run.id)}</td><td>${esc(run.agentName)}</td><td>${statusPill(run.status)}</td><td>$${Number(run.costUsd).toFixed(4)}</td><td>${fmt(run.createdAt)}</td><td><button class="btn ghost small" onclick="app.openRun('${esc(run.id)}')">查看</button></td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有运行", "打开 Agents 试运行一次，或调用开放 API。")}
    </div>`;
}

function stat(label, value, sub) {
  return `<div class="card stat"><div class="card-body"><div class="label">${label}</div><div class="value">${value ?? 0}</div><div class="sub">${sub}</div></div></div>`;
}

async function renderAgents() {
  const data = await api("/admin/api/agents");
  state.agents = data.items ?? [];
  const details = await Promise.all(state.agents.map((agent) => api(`/admin/api/agents/${agent.id}`).catch(() => null)));
  state.agents.forEach((agent, index) => {
    agent.draft = (details[index]?.versions ?? []).find((version) => version.status === "draft") ?? null;
  });
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>Agents</h3><p class="muted">发布版本、开启开放 API、试运行</p></div>
        <div class="actions"><button class="btn ghost" onclick="app.switchTab('packages')">安装能力包</button><button class="btn primary" onclick="app.openAgentCreate()">新建 Agent</button></div>
      </div>
      ${state.agents.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>名称</th><th>版本</th><th>开放 API</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${state.agents.map((agent) => `<tr>
          <td class="mono">${esc(agent.key)}</td><td><strong>${esc(agent.name)}</strong><div class="muted">${esc(agent.description)}</div></td>
          <td>${esc(agent.publishedVersion ?? "未发布")}</td>
          <td>${agent.apiEnabled ? `<span class="pill ok">已开放</span>` : `<span class="pill">未开放</span>`}</td>
          <td>${statusPill(agent.status)}</td>
          <td><div class="actions">
            <button class="btn ghost small" onclick="app.openAgentRun('${esc(agent.id)}','${esc(agent.name)}')">试运行</button>
            <button class="btn ghost small" onclick="app.openAgentNewVersion('${esc(agent.id)}','${esc(agent.name)}')">新版本</button>
            ${agent.draft ? `<button class="btn ghost small" onclick="app.publishAgent('${esc(agent.id)}')">发布草稿 ${esc(vLabel(agent.draft.version))}</button>` : ""}
            <button class="btn ghost small" onclick="app.toggleAgentApi('${esc(agent.id)}',${agent.apiEnabled ? "false" : "true"})">${agent.apiEnabled ? "关闭 API" : "开放 API"}</button>
            <button class="btn ghost small" onclick="app.openAgentDetail('${esc(agent.id)}')">详情</button>
          </div></td>
        </tr>`).join("")}
      </tbody></table></div>` : empty("还没有 Agent", "新建一个 Agent，默认使用离线 Mock 模型即可运行。", `<button class="btn primary" onclick="app.openAgentCreate()">新建 Agent</button>`)}
    </div>`;
}

async function renderModels() {
  const data = await api("/admin/api/providers");
  state.providers = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>模型 Provider</h3><p class="muted">支持内置 Mock 与任意 OpenAI-compatible 端点</p></div>
        <button class="btn primary" onclick="app.openProviderCreate()">添加 Provider</button></div>
      ${state.providers.length ? `<div class="card-body grid cols-2">${state.providers.map((provider) => `
        <div class="card" style="box-shadow:none">
          <div class="card-body">
            <div style="display:flex;justify-content:space-between;gap:8px"><strong>${esc(provider.name)}</strong>${statusPill(provider.status)}</div>
            <div class="muted mono">${esc(provider.key)} · ${esc(provider.protocol)}</div>
            <div class="mono" style="word-break:break-all">${esc(provider.baseUrl)}</div>
            <div style="margin-top:12px">${provider.models?.length ? provider.models.map((model) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--border)"><span class="mono">${esc(model.key)}</span><span class="pill">${esc(model.displayName)}</span></div>`).join("") : `<span class="muted">还没有模型</span>`}</div>
            <div class="actions" style="margin-top:12px">
              <button class="btn ghost small" onclick="app.openModelCreate('${esc(provider.id)}')">添加模型</button>
              <button class="btn ghost small" onclick="app.openProviderEdit('${esc(provider.id)}')">编辑 Provider</button>
              <button class="btn ghost small" onclick="app.testProvider('${esc(provider.id)}')">测试连接</button>
            </div>
          </div>
        </div>`).join("")}</div>` : empty("还没有 Provider", "添加一个 OpenAI-compatible 端点，或使用内置 Mock。", `<button class="btn primary" onclick="app.openProviderCreate()">添加 Provider</button>`)}
    </div>`;
}

async function renderMcp() {
  const data = await api("/admin/api/mcp");
  state.mcp = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>MCP 服务</h3><p class="muted">Streamable HTTP；添加后自动发现工具</p></div><button class="btn primary" onclick="app.openMcpCreate()">添加 MCP</button></div>
      ${state.mcp.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>名称</th><th>URL</th><th>工具</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${state.mcp.map((server) => `<tr><td class="mono">${esc(server.key)}</td><td>${esc(server.name)}</td><td class="mono">${esc(server.url)}</td><td>${server.tools?.length ?? 0}</td><td>${statusPill(server.status)}${server.lastError ? `<div class="muted">${esc(server.lastError)}</div>` : ""}</td><td><div class="actions"><button class="btn ghost small" onclick="app.refreshMcp('${esc(server.id)}')">刷新工具</button><button class="btn ghost small" onclick="app.openMcpEdit('${esc(server.id)}')">编辑</button></div></td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有 MCP", "添加一个远程 MCP 服务，Agent 即可使用其工具。")}
    </div>`;
}

async function renderSkills() {
  const data = await api("/admin/api/skills");
  state.skills = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>Skills</h3><p class="muted">SKILL.md 内容会注入 Agent 上下文</p></div><button class="btn primary" onclick="app.openSkillCreate()">新建 Skill</button></div>
      ${state.skills.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>名称</th><th>描述</th><th>状态</th><th></th></tr></thead><tbody>
        ${state.skills.map((skill) => `<tr><td class="mono">${esc(skill.key)}</td><td>${esc(skill.name)}</td><td>${esc(skill.description)}</td><td>${statusPill(skill.status)}</td><td><button class="btn ghost small" onclick="app.openSkillEdit('${esc(skill.id)}')">编辑</button></td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有 Skill", "创建一个 Skill，供 Agent 在 spec.skills 中引用。")}
    </div>`;
}

async function renderTools() {
  const data = await api("/admin/api/tool-sources");
  state.toolSources = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>工具源</h3><p class="muted">导入 OpenAPI 3.x，自动生成工具</p></div><button class="btn primary" onclick="app.openToolImport()">导入 OpenAPI</button></div>
      ${state.toolSources.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>名称</th><th>Base URL</th><th>工具数</th></tr></thead><tbody>
        ${state.toolSources.map((source) => `<tr><td class="mono">${esc(source.key)}</td><td>${esc(source.name)}</td><td class="mono">${esc(source.baseUrl)}</td><td>${source.tools?.length ?? 0}</td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有工具源", "导入 OpenAPI 后，在 Agent spec.toolsets 中引用。")}
    </div>`;
}

async function renderPackages() {
  const data = await api("/admin/api/plugins");
  state.plugins = data.items ?? [];
  const example = {
    key: "com.example.demo-pack",
    version: "1.0.0",
    type: "mixed",
    name: "示例能力包",
    resources: {
      skills: [{ key: "demo-skill", name: "演示技能", description: "示例", content: "# 演示技能\n\n回答要简洁。" }],
      agents: [{ key: "pack-agent", name: "包安装 Agent", version: "1.0.0", instructions: "你是包安装的演示助手。", spec: { model: { provider: "mock", model: "mock-1" }, toolsets: [{ builtin: ["current_time"] }], limits: { maxSteps: 3 } } }],
    },
  };
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>安装能力包</h3><p class="muted">声明式 JSON；安装 Agent、Skill、MCP、Provider</p></div></div>
      <div class="card-body">
        <textarea id="package-json" style="min-height:260px">${esc(JSON.stringify(example, null, 2))}</textarea>
        <div class="actions" style="margin-top:12px"><button class="btn primary" onclick="app.installPackage()">安装</button></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>已安装</h3><p class="muted">卸载只标记包状态，不删除已创建资源</p></div></div>
      ${state.plugins.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>名称</th><th>版本</th><th>类型</th><th>状态</th><th></th></tr></thead><tbody>
        ${state.plugins.map((plugin) => `<tr><td class="mono">${esc(plugin.key)}</td><td>${esc(plugin.name)}</td><td>${esc(plugin.version)}</td><td>${esc(plugin.type)}</td><td>${statusPill(plugin.status)}</td><td><button class="btn ghost small" onclick="app.uninstallPackage('${esc(plugin.id)}')">卸载</button></td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有安装记录", "安装一个能力包后会显示在这里。")}
    </div>`;
}

async function renderRuns() {
  const data = await api("/admin/api/runs?limit=100");
  state.runs = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>运行中心</h3><p class="muted">SSE 实时事件、消息、工具调用与审批</p></div><button class="btn ghost small" onclick="app.renderCurrent()">刷新</button></div>
      ${state.runs.length ? `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>状态</th><th>触发</th><th>成本</th><th>创建时间</th><th></th></tr></thead><tbody>
        ${state.runs.map((run) => `<tr><td class="mono">${esc(run.id)}</td><td>${esc(run.agentName)}</td><td>${statusPill(run.status)}</td><td>${esc(run.triggerType)}</td><td>$${Number(run.costUsd).toFixed(4)}</td><td>${fmt(run.createdAt)}</td><td><div class="actions"><button class="btn ghost small" onclick="app.openRun('${esc(run.id)}')">查看</button>${["queued","running","waiting_approval"].includes(run.status) ? `<button class="btn ghost small" onclick="app.cancelRun('${esc(run.id)}')">取消</button>` : ""}</div></td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有运行", "在 Agents 页面试运行，或通过开放 API 创建 Run。")}
    </div>`;
}

async function renderApprovals() {
  const data = await api("/admin/api/approvals");
  state.approvals = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>待审批</h3><p class="muted">高风险工具调用会暂停 Run</p></div><button class="btn ghost small" onclick="app.renderCurrent()">刷新</button></div>
      ${state.approvals.length ? `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>风险</th><th>过期时间</th><th>操作</th></tr></thead><tbody>
        ${state.approvals.map((approval) => `<tr><td class="mono">${esc(approval.run_id)}</td><td>${esc(approval.agent_name)}</td><td>${statusPill(approval.risk_level)}</td><td>${fmt(approval.expires_at)}</td><td><div class="actions"><button class="btn primary small" onclick="app.decideApproval('${esc(approval.id)}','approved')">批准</button><button class="btn danger small" onclick="app.decideApproval('${esc(approval.id)}','rejected')">驳回</button><button class="btn ghost small" onclick="app.openRun('${esc(approval.run_id)}')">查看 Run</button></div></td></tr>`).join("")}
      </tbody></table></div>` : empty("没有待审批", "高风险工具执行时会出现在这里。")}
    </div>`;
}

async function renderSchedules() {
  const [data, agents] = await Promise.all([api("/admin/api/schedules"), api("/admin/api/agents")]);
  state.schedules = data.items ?? [];
  state.agents = agents.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>定时任务</h3><p class="muted">Cron + 时区；以服务身份运行（普通用户权限，数据范围为创建者所在部门）</p></div><button class="btn primary" onclick="app.openScheduleCreate()">新建定时任务</button></div>
      ${state.schedules.length ? `<div class="table-wrap"><table><thead><tr><th>名称</th><th>Agent</th><th>Cron</th><th>时区</th><th>下次运行</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${state.schedules.map((schedule) => `<tr><td><strong>${esc(schedule.name)}</strong><div class="muted mono">${esc(schedule.key)}</div></td><td>${esc(schedule.agent_name)}</td><td class="mono">${esc(schedule.cron)}</td><td>${esc(schedule.timezone)}</td><td>${fmt(schedule.next_run_at)}</td><td>${statusPill(schedule.status)}</td><td><div class="actions">${schedule.status === "active" ? `<button class="btn ghost small" onclick="app.scheduleAction('${esc(schedule.id)}','disable')">停用</button>` : `<button class="btn ghost small" onclick="app.scheduleAction('${esc(schedule.id)}','enable')">启用</button>`}<button class="btn ghost small" onclick="app.openScheduleEdit('${esc(schedule.id)}')">编辑</button><button class="btn ghost small" onclick="app.scheduleAction('${esc(schedule.id)}','run')">立即运行</button></div></td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有定时任务", "创建一个 Cron 任务，框架会按计划提交 Run。")}
    </div>`;
}

async function renderApps() {
  const data = await api("/admin/api/apps");
  state.apps = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>开放平台应用</h3><p class="muted">API Key、Scope、配额与 Webhook</p></div><button class="btn primary" onclick="app.openAppCreate()">创建应用</button></div>
      ${state.apps.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>名称</th><th>Scopes</th><th>限额</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${state.apps.map((app) => `<tr><td class="mono">${esc(app.key)}</td><td>${esc(app.name)}</td><td class="mono">${esc((app.scopes ?? []).join(", "))}</td><td>${app.rateLimitPerMinute}/min · ${app.dailyQuota}/日</td><td>${statusPill(app.status)}</td><td><div class="actions"><button class="btn primary small" onclick="app.createAppKey('${esc(app.id)}')">新建密钥</button><button class="btn ghost small" onclick="app.listAppKeys('${esc(app.id)}')">查看密钥</button><button class="btn ghost small" onclick="app.openAppEdit('${esc(app.id)}')">编辑</button></div></td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有应用", "创建应用和 API Key，即可通过 /open/v1 调用 Agent。")}
    </div>`;
}

async function renderUsers() {
  const [users, permissions] = await Promise.all([api("/admin/api/users"), api("/admin/api/permissions")]);
  state.users = users.items ?? [];
  const roles = Object.keys(permissions.roles ?? {});
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>用户与权限</h3><p class="muted">功能角色决定可用功能，数据范围决定可见数据</p></div><button class="btn ghost small" onclick="app.showPermissionMatrix()">查看权限矩阵</button></div>
      ${state.users.length ? `<div class="table-wrap"><table><thead><tr><th>用户</th><th>邮箱</th><th>角色</th><th>数据范围</th><th>状态</th><th></th></tr></thead><tbody>
        ${state.users.map((user) => `<tr><td><strong>${esc(user.display_name)}</strong><div class="muted mono">${esc(user.id)}</div></td><td>${esc(user.email)}</td><td><select id="role-${esc(user.id)}">${roles.map((role) => `<option ${role === user.role ? "selected" : ""}>${role}</option>`).join("")}</select></td><td><select id="scope-${esc(user.id)}">${["all","org","self"].map((scope) => `<option ${scope === user.data_scope ? "selected" : ""}>${scope}</option>`).join("")}</select></td><td>${statusPill(user.status)}</td><td><button class="btn ghost small" onclick="app.saveUser('${esc(user.id)}')">保存</button></td></tr>`).join("")}
      </tbody></table></div>` : empty("没有用户", "SSO 用户首次登录会自动创建。")}
    </div>`;
}

async function renderSso() {
  const data = await api("/admin/api/sso");
  state.sso = data;
  $("#content").innerHTML = `
    <div class="grid cols-2">
      <div class="card"><div class="card-head"><div><h3>统一 SSO</h3><p class="muted">OIDC 授权码 + PKCE</p></div>${data.oidcConfigured ? `<span class="pill ok">已配置</span>` : `<span class="pill warn">待配置</span>`}</div>
        <div class="card-body">
          <div class="kv"><span>模式</span><strong>${esc(data.mode)}</strong></div>
          <div class="kv"><span>令牌校验</span><strong>${esc(data.tokenValidationMode)}</strong></div>
          <div class="kv"><span>角色映射</span><strong>${data.mappings?.length ?? 0} 条</strong></div>
          <p class="hint">生产必须为 required；未配置时使用本地应急管理员完成初始化。</p>
        </div>
      </div>
      <div class="card"><div class="card-head"><div><h3>Agent Connector</h3><p class="muted">签名配置 / Principal / callSystem</p></div>${data.connectorEnabled ? `<span class="pill ok">在线</span>` : `<span class="pill">关闭</span>`}</div>
        <div class="card-body">
          <div class="kv"><span>总开关</span><strong>${data.connectorEnabled}</strong></div>
          <div class="kv"><span>入站</span><strong>${data.connectorInbound}</strong></div>
          <div class="kv"><span>出站</span><strong>${data.connectorOutbound}</strong></div>
          <p class="hint">未拿到 Agent 管理员参数前保持关闭；入站只开放 /integration/v1。</p>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>SSO 角色映射</h3><p class="muted">Agent 角色 code/name → Forge 角色</p></div><button class="btn primary small" onclick="app.openRoleMapping()">添加映射</button></div>
      ${data.mappings?.length ? `<div class="table-wrap"><table><thead><tr><th>Agent Code</th><th>Agent Name</th><th>Forge 角色</th></tr></thead><tbody>${data.mappings.map((mapping) => `<tr><td class="mono">${esc(mapping.agent_role_code)}</td><td>${esc(mapping.agent_role_name)}</td><td>${esc(mapping.local_role)}</td></tr>`).join("")}</tbody></table></div>` : empty("还没有映射", "映射为空时 SSO 登录会被拒绝，这是有意的安全默认值。")}
    </div>`;
}

// ---------- modal ----------

function openModal(title, body, onSubmit, submitLabel = "保存", danger = false) {
  const dialog = $("#modal");
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = body;
  const submit = $("#modal-submit");
  submit.textContent = submitLabel;
  submit.className = `btn ${danger ? "danger" : "primary"}`;
  submit.type = "submit";
  const form = $("#modal-form");
  form.querySelectorAll('button[value="cancel"]').forEach((button) => {
    button.type = "button";
    button.onclick = () => dialog.close();
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await onSubmit(new FormData(form));
      dialog.close();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  };
  dialog.showModal();
}

function vLabel(version) {
  if (version === null || version === undefined || version === "") return "";
  const text = String(version);
  return text.startsWith("v") ? text : `v${text}`;
}

function confirmAction(title, message, confirmLabel, danger = true) {
  return new Promise((resolve) => {
    let confirmed = false;
    openModal(title, `<p style="margin:0">${esc(message)}</p>`, async () => { confirmed = true; }, confirmLabel, danger);
    $("#modal").addEventListener("close", () => resolve(confirmed), { once: true });
  });
}

function field(label, name, value = "", type = "text", extra = "") {
  return `<label>${label}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra} /></label>`;
}

function textarea(label, name, value = "", rows = 6) {
  return `<label>${label}<textarea name="${esc(name)}" rows="${rows}">${esc(value)}</textarea></label>`;
}

function select(label, name, options, value = "") {
  return `<label>${label}<select name="${esc(name)}">${options.map((option) => `<option value="${esc(option.value)}" ${option.value === value ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select></label>`;
}

function parseJsonField(data, key, fallback) {
  const raw = String(data.get(key) ?? "").trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${key} 不是合法 JSON`);
  }
}

// ---------- actions ----------

const app = {
  switchTab,
  renderCurrent,

  openAgentCreate() {
    const spec = JSON.stringify({ model: { provider: "mock", model: "mock-1", temperature: 0.2 }, toolsets: [{ builtin: ["current_time", "echo"] }], limits: { maxSteps: 4, maxCostUsd: 1 } }, null, 2);
    openModal("新建 Agent", `
      <div class="form-grid">
        ${field("Key", "key", "my-agent")}
        ${field("名称", "name", "我的 Agent")}
        <div class="full">${field("描述", "description", "")}</div>
        <div class="full">${textarea("Instructions", "instructions", "你是一个简洁、可靠的助手。")}</div>
        <div class="full">${textarea("Spec JSON", "spec", spec, 8)}</div>
      </div>`, async (data) => {
      const body = {
        key: data.get("key"),
        name: data.get("name"),
        description: data.get("description"),
        instructions: data.get("instructions"),
        spec: parseJsonField(data, "spec", {}),
        publish: true,
      };
      await api("/admin/api/agents", { method: "POST", body });
      toast("Agent 已创建并发布");
      await renderAgents();
    }, "创建并发布");
  },

  async openAgentNewVersion(id, name) {
    try {
      const detail = await api(`/admin/api/agents/${id}`);
      const latest = detail.versions?.[0];
      if (!latest) throw new Error("Agent 没有版本");
      openModal(`新建版本 · ${name}`, `
        <div class="form-grid">
          ${field("版本号", "version", "1.1.0")}
          <div class="full">${textarea("Instructions", "instructions", latest.instructions ?? "")}</div>
          <div class="full">${textarea("Spec JSON", "spec", JSON.stringify(latest.spec_json ?? {}, null, 2), 10)}</div>
        </div>`, async (data) => {
        await api(`/admin/api/agents/${id}/versions`, { method: "POST", body: { version: data.get("version"), instructions: data.get("instructions"), spec: parseJsonField(data, "spec", {}), publish: true } });
        toast("新版本已创建并发布");
        await renderAgents();
      }, "创建并发布");
    } catch (error) {
      toast(error.message, "error");
    }
  },

  openMcpEdit(id) {
    const server = state.mcp.find((item) => item.id === id);
    if (!server) return;
    openModal("编辑 MCP", `
      <div class="form-grid">
        ${field("名称", "name", server.name)}
        <div class="full">${field("HTTP URL", "url", server.url)}</div>
        <div class="full">${textarea("Headers JSON", "headers", JSON.stringify(server.headers_json ?? {}, null, 2), 4)}</div>
      </div>`, async (data) => {
      await api(`/admin/api/mcp/${id}`, { method: "PATCH", body: { name: data.get("name"), url: data.get("url"), headers: parseJsonField(data, "headers", {}) } });
      await api(`/admin/api/mcp/${id}/refresh`, { method: "POST", body: {} }).catch(() => null);
      toast("MCP 已更新");
      await renderMcp();
    });
  },

  async openSkillEdit(id) {
    try {
      const skill = await api(`/admin/api/skills/${id}`);
      const latest = skill.versions?.[0];
      openModal(`编辑 Skill · ${skill.name}`, `
        <div class="form-grid">
          ${field("名称", "name", skill.name)}
          ${field("新版本号", "version", "1.0.1")}
          <div class="full">${field("描述", "description", skill.description)}</div>
          <div class="full">${textarea("SKILL.md 内容", "content", latest?.content_md ?? "", 12)}</div>
        </div>`, async (data) => {
        await api(`/admin/api/skills/${id}`, { method: "PATCH", body: { name: data.get("name"), description: data.get("description") } });
        await api(`/admin/api/skills/${id}/versions`, { method: "POST", body: { version: data.get("version"), content: data.get("content"), publish: true } });
        toast("Skill 已更新并发布新版本");
        await renderSkills();
      }, "保存并发布");
    } catch (error) {
      toast(error.message, "error");
    }
  },

  openProviderEdit(id) {
    const provider = state.providers.find((item) => item.id === id);
    if (!provider) return;
    openModal("编辑 Provider", `
      <div class="form-grid">
        ${field("名称", "name", provider.name)}
        ${field("Base URL", "baseUrl", provider.baseUrl)}
        <div class="full">${field("新 API Key（留空不改）", "apiKey", "", "password")}</div>
        <div class="full">${textarea("Headers JSON", "headers", "{}", 4)}</div>
      </div>`, async (data) => {
      await api(`/admin/api/providers/${id}`, { method: "PATCH", body: { name: data.get("name"), baseUrl: data.get("baseUrl"), apiKey: data.get("apiKey") || undefined, headers: parseJsonField(data, "headers", {}) } });
      toast("Provider 已更新");
      await renderModels();
    });
  },

  openModelEdit(id) {
    for (const provider of state.providers) {
      const model = (provider.models ?? []).find((item) => item.id === id);
      if (!model) continue;
      openModal(`编辑模型 · ${model.key}`, `
        <div class="form-grid">
          ${field("显示名", "displayName", model.displayName)}
          ${field("上下文窗口", "contextWindow", model.contextWindow, "number")}
          ${field("最大输出", "maxOutputTokens", model.maxOutputTokens, "number")}
        </div>`, async (data) => {
        await api(`/admin/api/models/${id}`, { method: "PATCH", body: { displayName: data.get("displayName"), contextWindow: Number(data.get("contextWindow")), maxOutputTokens: Number(data.get("maxOutputTokens")) } });
        toast("模型已更新");
        await renderModels();
      });
      return;
    }
  },

  openAppEdit(id) {
    const app = state.apps.find((item) => item.id === id);
    if (!app) return;
    openModal("编辑应用", `
      <div class="form-grid">
        ${field("名称", "name", app.name)}
        ${select("状态", "status", [{ value: "active", label: "active" }, { value: "disabled", label: "disabled" }], app.status)}
        <div class="full">${field("Scopes", "scopes", (app.scopes ?? []).join(","))}</div>
        <div class="full">${field("Webhook URL", "webhookUrl", app.webhookUrl ?? "")}</div>
        <div class="full">${field("新 Webhook Secret（留空不改）", "webhookSecret", "", "password")}</div>
      </div>`, async (data) => {
      await api(`/admin/api/apps/${id}`, { method: "PATCH", body: { name: data.get("name"), status: data.get("status"), scopes: String(data.get("scopes") ?? "").split(",").map((item) => item.trim()).filter(Boolean), webhookUrl: data.get("webhookUrl"), webhookSecret: data.get("webhookSecret") || undefined } });
      toast("应用已更新");
      await renderApps();
    });
  },

  openScheduleEdit(id) {
    const schedule = state.schedules.find((item) => item.id === id);
    if (!schedule) return;
    openModal("编辑定时任务", `
      <div class="form-grid">
        ${field("名称", "name", schedule.name)}
        ${field("Cron", "cron", schedule.cron)}
        ${field("时区", "timezone", schedule.timezone)}
        <div class="full">${textarea("输入 JSON", "input", JSON.stringify(schedule.input_json ?? {}, null, 2), 5)}</div>
      </div>`, async (data) => {
      await api(`/admin/api/schedules/${id}`, { method: "PATCH", body: { name: data.get("name"), cron: data.get("cron"), timezone: data.get("timezone"), input: parseJsonField(data, "input", {}), status: schedule.status } });
      toast("定时任务已更新");
      await renderSchedules();
    });
  },

  openAgentRun(id, name) {
    openModal(`试运行 ${name}`, `${textarea("输入", "text", "你好，介绍一下 Forge。", 5)}`, async (data) => {
      const result = await api(`/admin/api/agents/${id}/run`, { method: "POST", body: { input: { text: data.get("text") } } });
      toast(`Run 已创建：${result.runId}`);
      state.tab = "runs";
      await switchTab("runs");
      setTimeout(() => app.openRun(result.runId), 300);
    }, "运行");
  },

  async publishAgent(id) {
    try {
      const detail = await api(`/admin/api/agents/${id}`);
      const draft = (detail.versions ?? []).find((version) => version.status === "draft");
      if (!draft) {
        toast("没有待发布的草稿，请先创建新版本", "error");
        return;
      }
      const next = vLabel(draft.version);
      const current = detail.publishedVersion ? `当前线上版本是 ${vLabel(detail.publishedVersion)}` : "这个 Agent 目前还没有线上版本";
      if (!(await confirmAction(`发布「${detail.name}」${next}`, `发布后开放 API 和定时任务会立即改用 ${next}，${current}。`, "确认发布", false))) return;
      await api(`/admin/api/agents/${id}/publish`, { method: "POST", body: { versionId: draft.id } });
      toast(`已发布 ${next}`);
      await renderAgents();
    } catch (error) {
      toast(error.message, "error");
    }
  },

  async toggleAgentApi(id, enabled) {
    try {
      const agent = state.agents.find((item) => item.id === id);
      if (!enabled && !(await confirmAction(`关闭「${agent?.name ?? id}」的开放 API`, "关闭后外部应用无法再发起新调用；已在运行的任务会继续完成，结果仍可查询。之后可以随时重新开放。", "确认关闭"))) return;
      await api(`/admin/api/agents/${id}`, { method: "PATCH", body: { apiEnabled: enabled } });
      toast(enabled ? "已开放 API" : "已关闭 API");
      await renderAgents();
    } catch (error) {
      toast(error.message, "error");
    }
  },

  async openAgentDetail(id) {
    try {
      const agent = await api(`/admin/api/agents/${id}`);
      openModal(`Agent ${agent.name}`, `<div class="code-block">${json(agent)}</div>`, async () => {}, "关闭");
    } catch (error) {
      toast(error.message, "error");
    }
  },

  openProviderCreate() {
    openModal("添加模型 Provider", `
      <div class="form-grid">
        ${field("Key", "key", "acme-llm")}
        ${field("名称", "name", "Acme 内网模型")}
        ${select("协议", "protocol", [{ value: "openai-compatible", label: "OpenAI-compatible" }, { value: "mock", label: "Mock (离线)" }], "openai-compatible")}
        ${field("Base URL", "baseUrl", "https://api.openai.com/v1")}
        <div class="full">${field("API Key", "apiKey", "", "password", "placeholder='可留空，使用环境变量头'")}</div>
        <div class="full">${textarea("额外 Headers JSON", "headers", "{}", 4)}</div>
      </div>`, async (data) => {
      await api("/admin/api/providers", {
        method: "POST",
        body: {
          key: data.get("key"),
          name: data.get("name"),
          protocol: data.get("protocol"),
          baseUrl: data.get("baseUrl"),
          apiKey: data.get("apiKey"),
          headers: parseJsonField(data, "headers", {}),
        },
      });
      toast("Provider 已添加");
      await renderModels();
    });
  },

  openModelCreate(providerId) {
    openModal("添加模型", `
      <div class="form-grid">
        ${field("模型 Key", "key", "gpt-4o-mini")}
        ${field("显示名", "displayName", "GPT-4o mini")}
        ${field("上下文窗口", "contextWindow", "32768", "number")}
        ${field("最大输出", "maxOutputTokens", "4096", "number")}
      </div>`, async (data) => {
      await api(`/admin/api/providers/${providerId}/models`, {
        method: "POST",
        body: {
          key: data.get("key"),
          displayName: data.get("displayName"),
          contextWindow: Number(data.get("contextWindow")),
          maxOutputTokens: Number(data.get("maxOutputTokens")),
        },
      });
      toast("模型已添加");
      await renderModels();
    });
  },

  async testProvider(id) {
    try {
      const result = await api(`/admin/api/providers/${id}/test`, { method: "POST", body: {} });
      toast(result.ok ? `连接成功：${result.content}` : `失败：${result.error}`, result.ok ? "ok" : "error");
    } catch (error) {
      toast(error.message, "error");
    }
  },

  openMcpCreate() {
    openModal("添加 MCP 服务", `
      <div class="form-grid">
        ${field("Key", "key", "docs-mcp")}
        ${field("名称", "name", "文档解析 MCP")}
        <div class="full">${field("HTTP URL", "url", "http://localhost:8090/mcp")}</div>
        <div class="full">${textarea("Headers JSON (值可写 env:VAR)", "headers", "{}", 4)}</div>
      </div>`, async (data) => {
      const result = await api("/admin/api/mcp", { method: "POST", body: { key: data.get("key"), name: data.get("name"), url: data.get("url"), headers: parseJsonField(data, "headers", {}) } });
      toast(result.warning ? `MCP 已保存，但工具发现失败：${result.warning}` : "MCP 已添加并发现工具", result.warning ? "error" : "ok");
      await renderMcp();
    });
  },

  async refreshMcp(id) {
    try {
      const result = await api(`/admin/api/mcp/${id}/refresh`, { method: "POST", body: {} });
      toast(`已刷新 ${result.tools?.length ?? 0} 个工具`);
      await renderMcp();
    } catch (error) {
      toast(error.message, "error");
    }
  },

  openSkillCreate() {
    openModal("新建 Skill", `
      <div class="form-grid">
        ${field("Key", "key", "my-skill")}
        ${field("名称", "name", "我的技能")}
        <div class="full">${field("描述", "description", "")}</div>
        <div class="full">${textarea("SKILL.md", "content", "---\\nname: my-skill\\ndescription: 示例技能\\n---\\n\\n# 技能说明\\n\\n在这里写指令。", 10)}</div>
      </div>`, async (data) => {
      await api("/admin/api/skills", { method: "POST", body: { key: data.get("key"), name: data.get("name"), description: data.get("description"), content: data.get("content"), publish: true } });
      toast("Skill 已创建");
      await renderSkills();
    });
  },

  openToolImport() {
    openModal("导入 OpenAPI", `
      <div class="form-grid">
        ${field("Key", "key", "erp")}
        ${field("名称", "name", "ERP API")}
        <div class="full">${field("Base URL", "baseUrl", "https://erp.example.com/api")}</div>
        <div class="full">${textarea("OpenAPI JSON", "spec", "{\\n  \\\"openapi\\\": \\\"3.0.0\\\", \\\"paths\\\": {}\\n}", 8)}</div>
      </div>`, async (data) => {
      await api("/admin/api/tool-sources/import", { method: "POST", body: { key: data.get("key"), name: data.get("name"), baseUrl: data.get("baseUrl"), spec: parseJsonField(data, "spec", {}) } });
      toast("工具源已导入");
      await renderTools();
    }, "导入");
  },

  async installPackage() {
    try {
      const raw = $("#package-json").value;
      const pack = JSON.parse(raw);
      const result = await api("/admin/api/plugins/install", { method: "POST", body: pack });
      toast(`安装完成：${Object.values(result.created ?? {}).flat().length} 个资源`);
      await renderPackages();
    } catch (error) {
      toast(error.message, "error");
    }
  },

  async uninstallPackage(id) {
    try {
      const plugin = state.plugins.find((item) => item.id === id);
      if (!(await confirmAction(`卸载能力包「${plugin?.name ?? plugin?.key ?? id}」`, "卸载只标记包状态，不会删除已经创建的 Agent、Skill、MCP 等资源。", "确认卸载"))) return;
      await api(`/admin/api/plugins/${id}/uninstall`, { method: "POST", body: {} });
      toast("已标记卸载");
      await renderPackages();
    } catch (error) {
      toast(error.message, "error");
    }
  },

  async openRun(id) {
    closeStream();
    try {
      const run = await api(`/admin/api/runs/${id}`);
      const messages = (run.messages ?? []).map((message) => `<div style="padding:10px 0;border-bottom:1px solid var(--border)"><div class="muted"><strong>${esc(message.role)}</strong> · #${message.seq}</div><div style="white-space:pre-wrap">${esc(message.content?.text ?? JSON.stringify(message.content))}</div></div>`).join("");
      const tools = (run.toolCalls ?? []).map((call) => `<div style="padding:10px 0;border-bottom:1px solid var(--border)"><div><strong>${esc(call.tool_key)}</strong> ${statusPill(call.status)}</div><div class="muted mono">${esc(JSON.stringify(call.args))}</div><div style="white-space:pre-wrap">${esc(call.result_text ?? "")}</div></div>`).join("");
      openModal(`Run ${run.id}`, `
        <div class="toolbar"><span>${statusPill(run.status)}</span><span class="muted">成本 $${Number(run.costUsd).toFixed(4)}</span>${["queued","running","waiting_approval"].includes(run.status) ? `<button class="btn danger small" type="button" onclick="app.cancelRun('${esc(run.id)}')">取消 Run</button>` : ""}</div>
        <div class="split">
          <div><h4>消息</h4>${messages || `<span class="muted">暂无消息</span>`}</div>
          <div><h4>工具调用</h4>${tools || `<span class="muted">暂无工具调用</span>`}<h4 style="margin-top:16px">实时事件</h4><div id="event-log" class="event-log"></div></div>
        </div>`, async () => {}, "关闭");
      listenRun(run.id);
    } catch (error) {
      toast(error.message, "error");
    }
  },

  async cancelRun(id) {
    try {
      await api(`/admin/api/runs/${id}/cancel`, { method: "POST", body: {} });
      toast("取消请求已提交");
      $("#modal").close();
      await renderRuns();
    } catch (error) {
      toast(error.message, "error");
    }
  },

  async decideApproval(id, decision) {
    openModal(decision === "approved" ? "批准工具调用" : "驳回工具调用", `${textarea("备注", "comment", "")}`, async (data) => {
      await api(`/admin/api/approvals/${id}/decide`, { method: "POST", body: { decision, comment: data.get("comment") } });
      toast(decision === "approved" ? "已批准，Run 将继续" : "已驳回");
      await renderApprovals();
    }, decision === "approved" ? "批准" : "确认驳回", decision !== "approved");
  },

  openScheduleCreate() {
    if (!state.agents.length) {
      toast("请先创建并发布一个 Agent", "error");
      return;
    }
    openModal("新建定时任务", `
      <div class="form-grid">
        ${field("Key", "key", `schedule-${Date.now()}`)}
        ${field("名称", "name", "每日任务")}
        <div class="full">${select("Agent", "agentId", state.agents.map((agent) => ({ value: agent.id, label: `${agent.name} (${agent.key})` })))}</div>
        ${field("Cron", "cron", "0 9 * * *")}
        ${field("时区", "timezone", "Asia/Shanghai")}
        <div class="full">${textarea("输入文本", "text", "执行今天的任务。", 4)}</div>
      </div>`, async (data) => {
      await api("/admin/api/schedules", { method: "POST", body: { key: data.get("key"), name: data.get("name"), agentId: data.get("agentId"), cron: data.get("cron"), timezone: data.get("timezone"), input: { text: data.get("text") }, enabled: true } });
      toast("定时任务已创建");
      await renderSchedules();
    }, "创建");
  },

  async scheduleAction(id, action) {
    try {
      if (action === "run") {
        const result = await api(`/admin/api/schedules/${id}/run`, { method: "POST", body: {} });
        toast(`Run 已创建：${result.runId}`);
        await switchTab("runs");
        return;
      }
      if (action === "disable") {
        const schedule = state.schedules.find((item) => item.id === id);
        const nextRun = schedule?.next_run_at ? `，下次计划的 ${fmt(schedule.next_run_at)} 会取消` : "";
        const message = `停用后不会再按 ${schedule?.cron ?? "Cron"}（${schedule?.timezone ?? "默认时区"}）自动运行${nextRun}。`;
        if (!(await confirmAction(`停用定时任务「${schedule?.name ?? id}」`, message, "确认停用"))) return;
      }
      await api(`/admin/api/schedules/${id}/${action}`, { method: "POST", body: {} });
      toast(action === "enable" ? "已启用" : "已停用");
      await renderSchedules();
    } catch (error) {
      toast(error.message, "error");
    }
  },

  openAppCreate() {
    openModal("创建开放平台应用", `
      <div class="form-grid">
        ${field("Key", "key", "partner-app")}
        ${field("名称", "name", "合作方应用")}
        <div class="full">${field("Webhook URL", "webhookUrl", "")}</div>
        <div class="full">${field("Webhook Secret", "webhookSecret", "", "password")}</div>
        <div class="full">${field("Scopes", "scopes", "agents:read,runs:create,runs:read,runs:cancel")}</div>
      </div>`, async (data) => {
      await api("/admin/api/apps", { method: "POST", body: { key: data.get("key"), name: data.get("name"), webhookUrl: data.get("webhookUrl"), webhookSecret: data.get("webhookSecret"), scopes: String(data.get("scopes") ?? "").split(",").map((item) => item.trim()).filter(Boolean) } });
      toast("应用已创建");
      await renderApps();
    }, "创建");
  },

  async createAppKey(appId) {
    try {
      const result = await api(`/admin/api/apps/${appId}/keys`, { method: "POST", body: { name: "default" } });
      openModal("API Key（只显示一次）", `<p class="muted">请立即复制保存，关闭后无法再次查看。</p><div class="code-block">${esc(result.key)}</div>`, async () => {}, "已保存");
    } catch (error) {
      toast(error.message, "error");
    }
  },

  async listAppKeys(appId) {
    try {
      const result = await api(`/admin/api/apps/${appId}/keys`);
      openModal("API Keys", `<div class="table-wrap"><table><thead><tr><th>名称</th><th>Prefix</th><th>状态</th><th>最后使用</th></tr></thead><tbody>${(result.items ?? []).map((key) => `<tr><td>${esc(key.name)}</td><td class="mono">${esc(key.prefix)}</td><td>${statusPill(key.status)}</td><td>${fmt(key.last_used_at)}</td></tr>`).join("")}</tbody></table></div>`, async () => {}, "关闭");
    } catch (error) {
      toast(error.message, "error");
    }
  },

  async saveUser(id) {
    try {
      const role = $(`#role-${CSS.escape(id)}`).value;
      const dataScope = $(`#scope-${CSS.escape(id)}`).value;
      await api(`/admin/api/users/${id}`, { method: "PATCH", body: { role, dataScope } });
      toast("用户权限已更新");
      await renderUsers();
    } catch (error) {
      toast(error.message, "error");
    }
  },

  async showPermissionMatrix() {
    const data = await api("/admin/api/permissions");
    const roles = Object.keys(data.roles ?? {});
    openModal("功能权限矩阵", `<div class="table-wrap"><table><thead><tr><th>角色</th><th>权限</th></tr></thead><tbody>${roles.map((role) => `<tr><td><strong>${esc(role)}</strong></td><td class="mono">${esc((data.roles[role] ?? []).join(", "))}</td></tr>`).join("")}</tbody></table></div>`, async () => {}, "关闭");
  },

  openRoleMapping() {
    openModal("添加 SSO 角色映射", `
      <div class="form-grid">
        ${field("Agent Role Code", "agentRoleCode", "admin")}
        ${field("Agent Role Name", "agentRoleName", "Administrator")}
        <div class="full">${select("Forge 角色", "localRole", Object.keys({ platform_admin: 1, org_admin: 1, builder: 1, operator: 1, auditor: 1, user: 1 }).map((role) => ({ value: role, label: role })))}</div>
      </div>`, async (data) => {
      await api("/admin/api/role-mappings", { method: "POST", body: { agentRoleCode: data.get("agentRoleCode"), agentRoleName: data.get("agentRoleName"), localRole: data.get("localRole") } });
      toast("映射已保存");
      await renderSso();
    });
  },
};

window.app = app;

function listenRun(runId) {
  closeStream();
  const log = $("#event-log");
  if (!log) return;
  const types = ["run.queued", "run.started", "run.resumed", "message.delta", "message.completed", "context.compressed", "model.retried", "output.rejected", "tool.started", "tool.retried", "tool.completed", "tool.failed", "approval.required", "approval.resolved", "run.completed", "run.failed", "run.cancelled", "run.budget_exhausted"];
  const source = new EventSource(`/admin/api/runs/${runId}/events`);
  state.eventSource = source;
  const append = (type, event) => {
    const row = document.createElement("div");
    row.className = "event-row";
    const payload = JSON.parse(event.data);
    row.innerHTML = `<span class="muted">${payload.seq}</span><span class="type">${esc(type)}</span><span>${esc(JSON.stringify(payload.data).slice(0, 320))}</span>`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    if (["run.completed", "run.failed", "run.cancelled", "run.budget_exhausted"].includes(type)) {
      source.close();
      state.eventSource = null;
    }
  };
  for (const type of types) source.addEventListener(type, (event) => append(type, event));
  source.onerror = () => {
    if (state.eventSource === source) source.close();
  };
}

function closeStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

init();
