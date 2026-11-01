const state = {
  session: null,
  tab: "dashboard",
  agents: [],
  providers: [],
  runs: [],
  schedules: [],
  apps: [],
  users: [],
  userFilters: { q: "", status: "", cursor: "", history: [] },
  auditFilters: { action: "", resourceType: "", resourceId: "", actorId: "", outcome: "", from: "", to: "", cursor: "", history: [] },
  approvals: [],
  mcp: [],
  skills: [],
  plugins: [],
  toolSources: [],
  secrets: [],
  sso: null,
  eventSource: null,
  runView: null,
};

const $ = (selector) => document.querySelector(selector);
const navGroups = [
  { label: "概览", items: [{ id: "dashboard", label: "总览", icon: "D", permission: "agent.view" }] },
  {
    label: "构建",
    items: [
      { id: "agents", label: "Agents", icon: "A", permission: "agent.view" },
      { id: "models", label: "模型", icon: "M", permission: "model.view" },
      { id: "mcp", label: "MCP 服务", icon: "C", permission: "mcp.view" },
      { id: "skills", label: "Skills", icon: "S", permission: "skill.view" },
      { id: "tools", label: "工具源", icon: "T", permission: "tool.view" },
      { id: "packages", label: "能力包", icon: "P", permission: "package.view" },
    ],
  },
  {
    label: "运行",
    items: [
      { id: "runs", label: "运行中心", icon: "R", permission: "run.view" },
      { id: "approvals", label: "审批中心", icon: "!", permission: "approval.view" },
      { id: "schedules", label: "定时任务", icon: "H", permission: "schedule.view" },
    ],
  },
  {
    label: "开放平台",
    items: [{ id: "apps", label: "应用与密钥", icon: "K", permission: "apikey.view" }],
  },
  {
    label: "治理",
    items: [
      { id: "users", label: "账号与权限", icon: "U", anyPermissions: ["user.view", "role.view"] },
      { id: "audit", label: "操作日志", icon: "L", permission: "audit.view" },
      { id: "secrets", label: "凭据", icon: "V", permission: "secret.manage" },
      { id: "sso", label: "SSO / Connector", icon: "I", permission: "sso.manage" },
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
  packages: ["能力包", "导入能力包，安装 Agent / Skill / MCP / 模型"],
  runs: ["运行中心", "查看执行日志、工具调用与实时事件"],
  approvals: ["审批中心", "处理高风险工具调用"],
  schedules: ["定时任务", "按计划以选定的服务账号运行"],
  apps: ["应用与密钥", "开放平台 API Key、配额与 Webhook"],
  users: ["账号与权限", ""],
  audit: ["操作日志", ""],
  secrets: ["凭据", ""],
  sso: ["SSO / Connector", "统一登录与 Agent 平台接入状态"],
};

// P2：拼进 API 路径的 id 先按仓库 id 格式校验——26 位，纯 ULID（seed，如 01J00000000000000000000006）或
// 3 位小写前缀 + "_" + 22 位 ULID 字符（core ulidWithPrefix，如 agt_…）；不合法直接抛错、不发请求，合法的照旧 encodeURIComponent。
function isEntityId(value) {
  return typeof value === "string" && /^(?:[0-9A-HJKMNP-TV-Z]{26}|[a-z]{3}_[0-9A-HJKMNP-TV-Z]{22})$/.test(value);
}

function idSeg(value) {
  if (!isEntityId(value)) throw new Error("ID 格式无效，已取消请求");
  return encodeURIComponent(value);
}

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
  // 空文案不弹（会话过期的错误已由 handleSessionExpired 提示过，errorText 对它返回空）
  if (!message) return;
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 4200);
}

// K-36：错误提示统一带上后端错误码（和新控制台一致），方便对照排查
function errorText(error) {
  if (!(error instanceof Error)) return String(error ?? "");
  if (error.sessionExpired) return "";
  return error.code ? `${error.message}（错误码 ${error.code}）` : error.message;
}

function revisionHeaders(resource) {
  if (!Number.isInteger(resource?.revision) || resource.revision < 1) throw new Error("配置版本已失效，请重新打开后操作");
  return { "If-Match": `"${resource.revision}"` };
}

async function api(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD" && state.session?.csrfToken) {
    headers["x-csrf-token"] = state.session.csrfToken;
  }
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    // 断网或请求被中断：不显示浏览器原文 Failed to fetch，统一成中文 + NET-0001（同新控制台 K-35）
    const error = new Error("网络连接失败");
    error.code = "NET-0001";
    throw error;
  }
  let text;
  try {
    text = await response.text();
  } catch (err) {
    // 响应头已到、读 body 时断网：同上统一成中文 + NET-0001；主动取消原样抛出
    if (err?.name === "AbortError") throw err;
    const error = new Error("网络连接失败");
    error.code = "NET-0001";
    throw error;
  }
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (response.status === 401) {
    // 不挂 code：登录失败的提示文案保持原样（只有后端 message，不追加错误码）。
    const error = new Error(payload?.error?.message ?? "登录已过期");
    error.status = 401;
    // options.auth = "login"：登录请求本身（密码错等），照旧抛出失败原因，不算过期；
    // options.auth = "probe"：会话检查（启动时 /auth/config、/auth/session，退出），安静显示登录页，不提示。
    if (options.auth === "login") throw error;
    if (options.auth === "probe") {
      showLogin();
      throw error;
    }
    error.sessionExpired = true;
    handleSessionExpired();
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `请求失败 (${response.status})`);
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    error.status = response.status;
    throw error;
  }
  return payload;
}

const SESSION_EXPIRED_TEXT = "登录已过期，请重新登录";

/** 会话过期（非登录/会话检查请求收到 401）：关掉所有打开的 <dialog>、关 SSE、显示登录页；同一轮只提示一次，重新登录（enterApp）后重置。 */
function handleSessionExpired() {
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  closeStream();
  showLogin();
  if (state.sessionExpiredNotified) return;
  state.sessionExpiredNotified = true;
  toast(SESSION_EXPIRED_TEXT, "error");
}

function showLogin() {
  closeStream();
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
    const auth = await api("/auth/config", { auth: "probe" });
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
        auth: "login",
      });
      location.hash = routeAfterLogin(location.hash.slice(1));
      await enterApp();
    } catch (error) {
      toast(errorText(error), "error");
    }
  });
  $("#password-change")?.addEventListener("click", () => { app.openPasswordChange().catch(error => toast(errorText(error), "error")); });
  $("#logout").addEventListener("click", async () => {
    try { await api("/auth/logout", { method: "POST", auth: "probe" }); showLogin(); }
    catch (error) { if (error.status === 401) showLogin(); else toast("退出登录失败，请重试", "error"); }
  });
  $("#refresh").addEventListener("click", () => refreshCurrent());
  bindAgentActions();
  window.addEventListener("hashchange", onHashChange);
  try {
    state.session = await api("/auth/session", { auth: "probe" });
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
  state.sessionExpiredNotified = false;
  showApp();
  checkHealth();
  clearInterval(checkHealth.timer);
  checkHealth.timer = setInterval(checkHealth, 30000);
  $("#user-chip").innerHTML = `<strong>${esc(state.session.user.name)}</strong><span>${esc(state.session.user.role)} · ${esc(state.session.user.dataScope)}</span>`;
  renderNav();
  await switchTab(location.hash.slice(1) || "dashboard");
}

function navAllowed(item) {
  return item.anyPermissions ? item.anyPermissions.some(canPermission) : !item.permission || canPermission(item.permission);
}

function routeAfterLogin(route) {
  const pages = navGroups.flatMap(group => group.items);
  const requested = route.split("/")[0];
  const allowed = pages.find(item => item.id === requested && navAllowed(item)) ?? pages.find(item => navAllowed(item));
  if (allowed?.id === "users") return route === "users/roles" && canPermission("role.view") || !canPermission("user.view") ? "users/roles" : "users";
  return allowed?.id === requested ? route : allowed?.id ?? "agents";
}

function renderNav() {
  const nav = $("#nav");
  const restoreFocus = nav.contains(document.activeElement);
  nav.innerHTML = navGroups
    .filter(group => group.items.some(navAllowed))
    .map(
      (group) => `
      <div class="nav-section">${group.label}</div>
      ${group.items
        .filter(navAllowed)
        .map(
          (item) => `<button class="nav-item ${state.tab === item.id ? "active" : ""}" ${state.tab === item.id ? 'aria-current="page"' : ""} onclick="app.switchTab('${item.id}')">
            <span class="nav-icon" aria-hidden="true">${item.icon}</span><span>${item.label}</span>
          </button>`,
        )
        .join("")}
    `,
    )
    .join("");
  const selected = nav.querySelector('[aria-current="page"]');
  if (restoreFocus) selected?.focus({ preventScroll: true });
  selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// 对象深链接保留目标 ID，避免从审批跳转后重新在列表里寻找。
function parseRoute(route) {
  const raw = String(route ?? "").replace(/^#/, "");
  const slash = raw.indexOf("/");
  const tab = slash === -1 ? raw : raw.slice(0, slash);
  let id = slash === -1 ? "" : raw.slice(slash + 1);
  try {
    id = decodeURIComponent(id);
  } catch {
    id = "";
  }
  return { tab, id };
}

// switchTab 会先把规范化后的路由写回 location.hash；对这次写入触发的 hashchange 不再渲染第二遍。
function onHashChange() {
  const route = location.hash.slice(1) || "dashboard";
  if (route === state.route) return;
  return switchTab(route);
}

async function switchTab(route) {
  const navigation = (state.navigation ?? 0) + 1; state.navigation = navigation;
  let { tab, id } = parseRoute(route);
  if (!tabMeta[tab]) tab = "dashboard";
  if (tab === "users") id = id === "roles" || (!canPermission("user.view") && canPermission("role.view")) ? "roles" : "";
  else if (!((tab === "agents" && id === "new") || (["agents", "runs"].includes(tab) && isEntityId(id)))) id = "";
  state.accountSection = id === "roles" ? "roles" : "accounts";
  state.tab = tab;
  state.route = id ? `${tab}/${encodeURIComponent(id)}` : tab;
  location.hash = state.route;
  $("#page-title").textContent = tabMeta[tab][0];
  $("#page-subtitle").textContent = tabMeta[tab][1];
  renderNav();
  $("#content").innerHTML = `<div class="card"><div class="card-body muted">加载中…</div></div>`;
  try {
    await renderCurrent();
    if (navigation !== state.navigation) return;
    if (tab === "agents" && id === "new") {
      if (canPermission("agent.manage")) app.openAgentCreate();
    } else if (tab === "agents" && id) await app.openAgentDetail(id, navigation);
    else if (tab === "runs" && id) await app.openRun(id, navigation);
  } catch (error) {
    if (navigation === state.navigation) $("#content").innerHTML = errorCard(error);
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
    case "users": return state.accountSection === "roles" ? renderRoles() : renderUsers();
    case "audit": return renderAudit();
    case "sso": return renderSso();
    case "secrets": return renderSecrets();
    default: return renderDashboard();
  }
}

/**
 * 页面上的「刷新 / 重试」（顶栏 #refresh、加载失败卡片的重试、运行中心和待审批的刷新）：失败不留未捕获的 rejection。
 * 会话过期已由 handleSessionExpired 提示过一次（errorText 返回空，toast 不弹）；其他错误照常弹错误 toast。
 */
function refreshCurrent() {
  return renderCurrent().catch((error) => toast(errorText(error), "error"));
}

function errorCard(error) {
  return `<div class="card"><div class="card-body"><strong>加载失败</strong><p class="muted">${esc(errorText(error))}</p><button class="btn ghost" onclick="app.renderCurrent()">重试</button></div></div>`;
}

function empty(title, text, action = "") {
  return `<div class="empty"><strong>${esc(title)}</strong><span>${esc(text)}</span>${action ? `<div style="margin-top:14px">${action}</div>` : ""}</div>`;
}

function statusPill(status, label) {
  const map = {
    active: "ok", succeeded: "ok", approved: "ok",
    queued: "info", running: "info", waiting_approval: "warn", pending: "warn", disabled: "warn",
    failed: "bad", rejected: "bad", cancelled: "bad", expired: "bad", budget_exhausted: "bad",
  };
  const labels = { active: "启用", succeeded: "成功", approved: "已批准", queued: "排队中", running: "运行中", waiting_approval: "待审批", pending: "待处理", disabled: "停用", failed: "失败", rejected: "已驳回", cancelled: "已取消", expired: "已过期", budget_exhausted: "预算耗尽", draft: "草稿", published: "已发布" };
  return `<span class="pill ${map[status] ?? ""}">${esc(label ?? labels[status] ?? status)}</span>`;
}

async function renderDashboard() {
  const data = await api("/admin/api/dashboard");
  const runs = canPermission("run.view") ? await api("/admin/api/runs?limit=6") : { items: [] };
  const byStatus = data.runsByStatus ?? {};
  $("#content").innerHTML = `
    <div class="grid dashboard-stats">
      ${canPermission("run.view") ? stat("今日运行", data.runsToday, "当前实例") : ""}
      ${stat("Agents", data.agents, "已配置")}
      ${canPermission("approval.view") ? stat("待审批", data.pendingApprovals, "需要处理") : ""}
      ${canPermission("run.view") ? stat("运行中", (byStatus.running ?? 0) + (byStatus.queued ?? 0), "队列 + 执行中") : ""}
    </div>
    <div class="grid cols-2">
      ${canPermission("agent.manage") || (canPermission("model.view") && canPermission("model.manage")) || (canPermission("package.view") && canPermission("plugin.install")) ? `<div class="card">
        <div class="card-head"><div><h3>快速开始</h3><p class="muted">离线 Mock 模型已就绪</p></div></div>
        <div class="card-body actions">
          ${canPermission("agent.manage") ? `<button class="btn primary" onclick="app.openAgentCreate()">新建 Agent</button>` : ""}
          ${canPermission("model.manage") && canPermission("model.view") ? `<button class="btn ghost" onclick="app.openProviderCreate()">接入自定义模型</button>` : ""}
          ${canPermission("package.view") && canPermission("plugin.install") ? `<button class="btn ghost" onclick="app.switchTab('packages')">安装能力包</button>` : ""}
        </div>
      </div>` : ""}
      ${canPermission("run.view") ? `<div class="card">
        <div class="card-head"><div><h3>运行状态</h3><p class="muted">按状态统计</p></div></div>
        <div class="card-body">
          ${Object.entries(byStatus).length ? Object.entries(byStatus).map(([key, value]) => `<div style="display:flex;justify-content:space-between;padding:5px 0"><span>${statusPill(key)}</span><strong>${value}</strong></div>`).join("") : `<span class="muted">暂无运行</span>`}
        </div>
      </div>` : ""}
    </div>
    ${canPermission("run.view") ? `<div class="card">
      <div class="card-head"><div><h3>最近运行</h3><p class="muted">点开查看消息与工具调用</p></div><button class="btn ghost small" onclick="app.switchTab('runs')">全部</button></div>
      ${runs.items?.length ? `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>状态</th><th>成本</th><th>时间</th><th></th></tr></thead><tbody>
        ${runs.items.map((run) => `<tr><td class="mono">${esc(run.id)}</td><td>${esc(run.agentName)}</td><td>${statusPill(run.status)}</td><td>$${Number(run.costUsd).toFixed(4)}</td><td>${fmt(run.createdAt)}</td><td>${canPermission("run.view") ? `<button class="btn ghost small" onclick="app.openRun('${esc(run.id)}')">查看</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有运行", "打开 Agents 试运行一次，或调用开放 API。")}
    </div>` : ""}`;
}

function stat(label, value, sub) {
  return `<div class="card stat"><div class="card-body"><div class="label">${label}</div><div class="value">${value ?? 0}</div><div class="sub">${sub}</div></div></div>`;
}

async function renderAgents() {
  const data = await api("/admin/api/agents");
  state.agents = data.items ?? [];
  // 列表接口自带 draftVersion（3db19c1），不再逐个请求详情。
  state.agents.forEach((agent) => {
    agent.draft = agent.draftVersion ?? null;
  });
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>Agents</h3><p class="muted">发布版本、开启开放 API、试运行</p></div>
        <div class="actions">${canPermission("package.view") && canPermission("plugin.install") ? `<button class="btn ghost" onclick="app.switchTab('packages')">安装能力包</button>` : ""}${canPermission("agent.manage") ? `<button class="btn primary" onclick="app.openAgentCreate()">新建 Agent</button>` : ""}</div>
      </div>
      ${state.agents.length ? `<div class="table-wrap"><table class="agent-table"><thead><tr><th>Key</th><th>名称</th><th>版本</th><th>开放 API</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${state.agents.map((agent) => `<tr>
          <td class="mono">${esc(agent.key)}</td><td><strong><a href="#agents/${esc(encodeURIComponent(agent.id))}" data-action="agent-detail" data-agent-id="${esc(agent.id)}">${esc(agent.name)}</a></strong><div class="muted">${esc(agent.description)}</div></td>
          <td>${esc(agent.publishedVersion ?? "未发布")}</td>
          <td>${agent.apiEnabled ? `<span class="pill ok">已开放</span>` : `<span class="pill">未开放</span>`}</td>
          <td>${statusPill(agent.status)}</td>
          <td><div class="actions">
            ${canPermission("agent.run") ? `<button class="btn ghost small" type="button" data-action="agent-run" data-agent-id="${esc(agent.id)}">试运行</button>` : ""}
            <details class="row-menu"><summary class="btn ghost small">更多</summary><div class="row-menu-actions">
            ${canPermission("agent.publish") ? `<button class="btn ghost small" type="button" data-action="agent-new-version" data-agent-id="${esc(agent.id)}">新版本草稿</button>` : ""}
            ${agent.draft ? `${canPermission("agent.publish") ? `<button class="btn ghost small" onclick="app.publishAgent('${esc(agent.id)}')">发布草稿 ${esc(vLabel(agent.draft.version))}</button>` : ""}` : ""}
            ${canPermission("agent.manage") ? `<button class="btn ghost small" onclick="app.toggleAgentApi('${esc(agent.id)}',${agent.apiEnabled ? "false" : "true"})">${agent.apiEnabled ? "关闭 API" : "开放 API"}</button>` : ""}
            <button class="btn ghost small" onclick="app.openAgentDetail('${esc(agent.id)}')">配置详情</button>
            </div></details>
          </div></td>
        </tr>`).join("")}
      </tbody></table></div>` : empty("还没有 Agent", "新建一个 Agent，默认使用离线 Mock 模型即可运行。", `${canPermission("agent.manage") ? `<button class="btn primary" onclick="app.openAgentCreate()">新建 Agent</button>` : ""}`)}
    </div>`;
}

function canManageSecrets() {
  const permissions = state.session?.permissions;
  return Array.isArray(permissions) && (permissions.includes("*") || permissions.includes("secret.manage"));
}

function secretScopeText(scope) {
  if (scope.type === "platform") return "平台";
  if (scope.type === "org") return `组织 · ${scope.id}`;
  return `${secretResourceDirectories()[scope.resourceType]?.[0] ?? scope.resourceType} · ${scope.id}`;
}

async function renderSecrets(cursor = "") {
  const data = await api(`/admin/api/secrets?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  state.secrets = data.items;
  state.secretNextCursor = data.nextCursor;
  $("#content").innerHTML = `<div class="card">
    <div class="card-head"><h3>凭据</h3><button class="btn primary" onclick="app.openSecretCreate()">新建凭据</button></div>
    ${data.items.length ? `<div class="table-wrap"><table class="secret-table"><thead><tr><th>名称 / Key</th><th>作用域</th><th>版本</th><th>主密钥版本</th><th>引用数</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${data.items.map(secret => `<tr><td><strong>${esc(secret.name)}</strong><div class="mono muted">${esc(secret.key)}</div></td><td class="mono">${esc(secretScopeText(secret.scope))}</td><td>${secret.activeVersion}</td><td class="mono">${esc(secret.keyVersion)}</td><td>${secret.referenceCount}</td><td>${statusPill(secret.status)}</td><td><div class="actions">
        <button class="btn ghost small" onclick="app.openSecretDetail('${esc(secret.id)}')">详情</button>
        <button class="btn ghost small" onclick="app.openSecretEdit('${esc(secret.id)}')">编辑</button>
        <button class="btn ghost small" onclick="app.openSecretRotate('${esc(secret.id)}')">轮换</button>
        <button class="btn ghost small" onclick="app.setSecretStatus('${esc(secret.id)}')">${secret.status === "active" ? "停用" : "启用"}</button>
        <button class="btn ghost small" onclick="app.deleteSecret('${esc(secret.id)}')">删除</button>
      </div></td></tr>`).join("")}</tbody></table></div>` : `<div class="card-body muted">暂无凭据</div>`}
    ${cursor || data.nextCursor ? `<div class="card-body actions">${cursor ? `<button class="btn ghost small" onclick="app.secretFirstPage()">首页</button>` : ""}${data.nextCursor ? `<button class="btn ghost small" onclick="app.secretNextPage()">下一页</button>` : ""}</div>` : ""}
  </div>`;
}


function credentialReferenceField(label, name, value = "") {
  return canManageSecrets() ? `<div class="full"><label>${esc(label.replace(" ID", ""))}<select name="${esc(name)}" data-secret-picker><option value="">不绑定已有凭据</option>${value ? `<option value="${esc(value)}" selected>当前已绑定凭据</option>` : ""}</select></label></div>` : "";
}

function credentialHeaderFields(resource = {}) {
  return `<details class="full advanced-config"><summary>请求头设置（选填）</summary><p class="hint">默认保留已有请求头值；需要替换时逐行填写。凭据值不会回显。</p>${recordFields("替换请求头值", "headers", {}, { optional: true, credential: true, header: true })}${canManageSecrets() ? recordFields("请求头凭据", "headerSecretRefs", resource.headerSecretRefs ?? {}, { secret: true, header: true }) : ""}</details>`;
}

function credentialHeadersChange(data, resource = {}) {
  const raw = String(data.get("headers") ?? "").trim(), refRaw = data.get("headerSecretRefs");
  const values = raw ? parseJsonField(data, "headers", {}) : undefined;
  const refs = refRaw == null ? undefined : parseJsonField(data, "headerSecretRefs", {});
  const same = refs !== undefined && JSON.stringify(refs) === JSON.stringify(resource.headerSecretRefs ?? {});
  if (values !== undefined && refs !== undefined) {
    for (const name of Object.keys(values)) for (const ref of Object.keys(refs)) if (ref.toLowerCase() === name.toLowerCase()) delete refs[ref];
  }
  return { ...(values !== undefined ? { headers: values } : {}), ...(refs !== undefined && (!same || values !== undefined) ? { headerSecretRefs: refs } : {}) };
}

function credentialReferenceChange(data, name, current, rawName) {
  const ref = data.get(name), value = String(ref ?? "").trim();
  if (ref == null || value === (current ?? "")) return {};
  if (data.get(rawName)) throw new Error("凭据值和引用不能同时指定");
  return { [name]: value || null };
}

async function renderModels() {
  const data = await api("/admin/api/providers");
  state.providers = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>模型 Provider</h3><p class="muted">支持内置 Mock 与任意 OpenAI-compatible 端点</p></div>
        ${canPermission("model.manage") && canPermission("model.view") ? `<button class="btn primary" onclick="app.openProviderCreate()">添加 Provider</button>` : ""}</div>
      ${state.providers.length ? `<div class="card-body grid cols-2">${state.providers.map((provider) => `
        <div class="card" style="box-shadow:none">
          <div class="card-body">
            <div style="display:flex;justify-content:space-between;gap:8px"><strong>${esc(provider.name)}</strong>${statusPill(provider.status)}</div>
            <div class="muted mono">${esc(provider.key)} · ${esc(provider.protocol)}</div>
            <div class="mono" style="word-break:break-all">${esc(provider.baseUrl)}</div>
            <div style="margin-top:12px">${provider.models?.length ? provider.models.map((model) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--border)"><span class="mono">${esc(model.key)}</span><span class="pill">${esc(model.displayName)}</span></div>`).join("") : `<span class="muted">还没有模型</span>`}</div>
            <div class="actions" style="margin-top:12px">
              ${canPermission("model.manage") ? `<button class="btn ghost small" onclick="app.openModelCreate('${esc(provider.id)}')">添加模型</button>` : ""}
              ${canPermission("model.manage") ? `<button class="btn ghost small" onclick="app.openProviderEdit('${esc(provider.id)}')">编辑 Provider</button>` : ""}
              ${canPermission("model.manage") ? `<button class="btn ghost small" onclick="app.testProvider('${esc(provider.id)}')">测试连接</button>` : ""}
            </div>
          </div>
        </div>`).join("")}</div>` : empty("还没有 Provider", "添加一个 OpenAI-compatible 端点，或使用内置 Mock。", `${canPermission("model.manage") && canPermission("model.view") ? `<button class="btn primary" onclick="app.openProviderCreate()">添加 Provider</button>` : ""}`)}
    </div>`;
}

async function renderMcp() {
  const data = await api("/admin/api/mcp");
  state.mcp = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>MCP 服务</h3><p class="muted">Streamable HTTP；添加后自动发现工具</p></div>${canPermission("mcp.manage") ? `<button class="btn primary" onclick="app.openMcpCreate()">添加 MCP</button>` : ""}</div>
      ${state.mcp.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>名称</th><th>URL</th><th>工具</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${state.mcp.map((server) => `<tr><td class="mono">${esc(server.key)}</td><td>${esc(server.name)}</td><td class="mono">${esc(server.url)}</td><td>${server.tools?.length ?? 0}</td><td>${statusPill(server.status)}${server.lastError ? `<div class="muted">${esc(server.lastError)}</div>` : ""}</td><td><div class="actions">${canPermission("mcp.manage") ? `<button class="btn ghost small" onclick="app.refreshMcp('${esc(server.id)}')">刷新工具</button>` : ""}${canPermission("mcp.manage") ? `<button class="btn ghost small" onclick="app.openMcpEdit('${esc(server.id)}')">编辑</button>` : ""}</div></td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有 MCP", "添加一个远程 MCP 服务，Agent 即可使用其工具。")}
    </div>`;
}

async function renderSkills() {
  const data = await api("/admin/api/skills");
  state.skills = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>Skills</h3><p class="muted">SKILL.md 内容会注入 Agent 上下文</p></div>${canPermission("skill.manage") ? `<button class="btn primary" onclick="app.openSkillCreate()">新建 Skill</button>` : ""}</div>
      ${state.skills.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>名称</th><th>描述</th><th>状态</th><th></th></tr></thead><tbody>
        ${state.skills.map((skill) => `<tr><td class="mono">${esc(skill.key)}</td><td>${esc(skill.name)}</td><td>${esc(skill.description)}</td><td>${statusPill(skill.status)}</td><td>${canPermission("skill.manage") ? `<button class="btn ghost small" onclick="app.openSkillEdit('${esc(skill.id)}')">编辑</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有 Skill", "创建一个 Skill，供 Agent 在 spec.skills 中引用。")}
    </div>`;
}

async function renderTools() {
  const data = await api("/admin/api/tool-sources");
  state.toolSources = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>工具源</h3><p class="muted">导入 OpenAPI 3.x，自动生成工具</p></div>${canPermission("tool.manage") ? `<button class="btn primary" onclick="app.openToolImport()">导入 OpenAPI</button>` : ""}</div>
      ${state.toolSources.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>名称</th><th>Base URL</th><th>工具数</th></tr></thead><tbody>
        ${state.toolSources.map((source) => `<tr><td class="mono">${esc(source.key)}</td><td>${esc(source.name)}</td><td class="mono">${esc(source.baseUrl)}</td><td>${source.tools?.length ?? 0}</td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有工具源", "导入后，可在 Agent 的工具设置中勾选使用。")}
    </div>`;
}

async function renderPackages() {
  const data = await api("/admin/api/plugins");
  state.plugins = data.items ?? [];
  $("#content").innerHTML = `
    ${canPermission("plugin.install") ? `<div class="card">
      <div class="card-head"><div><h3>安装能力包</h3><p class="muted">选择提供方给出的能力包文件，安装其中的 Agent、Skill、MCP 或模型。</p></div></div>
      <div class="card-body">
        <label>能力包文件<input id="package-file" type="file" accept=".json,application/json" /></label><details class="advanced-config"><summary>高级：粘贴能力包配置</summary><label>配置内容<textarea id="package-json" rows="8"></textarea></label></details>
        <div class="actions" style="margin-top:12px"><button class="btn primary" onclick="app.installPackage()">安装</button></div>
      </div>
    </div>` : ""}
    <div class="card">
      <div class="card-head"><div><h3>已安装</h3><p class="muted">卸载只标记包状态，不删除已创建资源</p></div></div>
      ${state.plugins.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>名称</th><th>版本</th><th>类型</th><th>状态</th><th></th></tr></thead><tbody>
        ${state.plugins.map((plugin) => `<tr><td class="mono">${esc(plugin.key)}</td><td>${esc(plugin.name)}</td><td>${esc(plugin.version)}</td><td>${esc(plugin.type)}</td><td>${statusPill(plugin.status)}</td><td>${canPermission("plugin.uninstall") ? `<button class="btn ghost small" onclick="app.uninstallPackage('${esc(plugin.id)}')">卸载</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有安装记录", "安装一个能力包后会显示在这里。")}
    </div>`;
}

async function renderRuns() {
  const navigation = state.navigation, ticket = (state.runsRequest ?? 0) + 1;
  state.runsRequest = ticket;
  const data = await api("/admin/api/runs?limit=100");
  if (navigation !== state.navigation || state.tab !== "runs" || ticket !== state.runsRequest) return;
  state.runs = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>运行中心</h3><p class="muted">SSE 实时事件、消息、工具调用与审批</p></div><button class="btn ghost small" onclick="app.renderCurrent()">刷新</button></div>
      ${state.runs.length ? `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>状态</th><th>触发</th><th>成本</th><th>创建时间</th><th></th></tr></thead><tbody>
        ${state.runs.map((run) => `<tr><td class="mono">${esc(run.id)}</td><td>${esc(run.agentName)}</td><td>${statusPill(run.status)}</td><td>${esc(run.triggerType)}</td><td>$${Number(run.costUsd).toFixed(4)}</td><td>${fmt(run.createdAt)}</td><td><div class="actions">${canPermission("run.view") ? `<button class="btn ghost small" onclick="app.openRun('${esc(run.id)}')">查看</button>` : ""}${["queued","running","waiting_approval"].includes(run.status) ? `${canPermission("run.cancel") ? `<button class="btn ghost small" onclick="app.cancelRun('${esc(run.id)}')">取消</button>` : ""}` : ""}</div></td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有运行", "在 Agents 页面试运行，或通过开放 API 创建 Run。")}
    </div>`;
}

// R9：Worker 接手中断后转人工确认的审批（reason=interrupted）。reason 缺失（老后端）或未知值一律按 policy 处理。
const INTERRUPTED_BADGE_TEXT = "执行中断，可能已执行过";
// 批准/驳回一条已处理、已被接手替换、已过期或并发输掉的审批：409 + 其中一个码（APR-2104 审批已处理或已过期，APR-2103 并发决定，
// RUN-7005 审批仍 pending 但所属 Run 已结束）。码集合只在这一行定义，只用于审批操作；其他操作收到 RUN-7005 照旧走 errorText。
// CFG-8503 是通用「资源状态冲突」，不在集合里，照普通错误提示。后端统一用 APR-2104，APR-2103 仅作兜底。
const APPROVAL_STALE_CODES = new Set(["APR-2104", "APR-2103", "RUN-7005"]);
const APPROVAL_STALE_TEXT = "该审批已失效，请刷新后处理新的审批";
// RUN-7005 的专门文案（和 /next/ 一致）。
const APPROVAL_RUN_FINISHED_TEXT = "Run 已结束，此审批已失效";
// SSE approval.resolved decision=expired（Run 进入终态时后端让挂着的审批失效）：确认框正开着时的中性轻提示（和 /next/ 一致）。
const APPROVAL_RESOLVED_EXPIRED_TEXT = "此审批已失效";

function approvalReason(approval) {
  return approval?.reason === "interrupted" ? "interrupted" : "policy";
}

/** attempt = 被中断那次执行的序号（从 1 开始）；正整数时返回「第 N 次执行被中断」，null / 缺失 / 非法值返回空串。 */
function attemptText(attempt) {
  return Number.isInteger(attempt) && attempt > 0 ? `第 ${attempt} 次执行被中断` : "";
}

/** 审批列表「风险」列里追加的中断徽标；policy 返回空串（和原来一样）。 */
function approvalReasonHtml(approval) {
  if (approvalReason(approval) !== "interrupted") return "";
  const attempt = attemptText(approval.attempt);
  return ` <span class="pill warn">${esc(INTERRUPTED_BADGE_TEXT)}</span>${attempt ? ` <span class="muted">${esc(attempt)}</span>` : ""}`;
}

// refetch=false：按 state.approvals 本地重渲染（approval.resolved 移除某条后用），不请求接口。
async function renderApprovals({ refetch = true } = {}) {
  if (refetch) {
    const data = await api("/admin/api/approvals");
    state.approvals = data.items ?? [];
  }
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>待审批</h3><p class="muted">高风险工具调用会暂停 Run</p></div><button class="btn ghost small" onclick="app.renderCurrent()">刷新</button></div>
      ${state.approvals.length ? `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>风险</th><th>过期时间</th><th>操作</th></tr></thead><tbody>
        ${state.approvals.map((approval) => `<tr><td class="mono">${esc(approval.run_id)}</td><td>${esc(approval.agent_name)}</td><td>${statusPill(approval.risk_level)}${approvalReasonHtml(approval)}</td><td>${fmt(approval.expires_at)}</td><td><div class="actions">${canPermission("approval.decide") ? `<button class="btn primary small" onclick="app.decideApproval('${esc(approval.id)}','approved')">批准</button>` : ""}${canPermission("approval.decide") ? `<button class="btn danger small" onclick="app.decideApproval('${esc(approval.id)}','rejected')">驳回</button>` : ""}${canPermission("run.view") ? `<button class="btn ghost small" onclick="app.openRun('${esc(approval.run_id)}')">查看 Run</button>` : ""}</div></td></tr>`).join("")}
      </tbody></table></div>` : empty("没有待审批", "高风险工具执行时会出现在这里。")}
    </div>`;
}

/**
 * SSE approval.resolved { approvalId, decision }：只处理 decision=expired（Run 已进入终态、审批被后端置为失效），不弹错误、不写 console.error。
 * - approvalId 在当前审批列表里：从列表移除；审批页正显示时按本地数据重渲染。
 * - 该审批的确认框正开着：关掉，并给中性轻提示（kind=info，没有专门样式，显示为默认深色底，不是红色 error）。
 * - 其他 decision / 未知值 / 缺字段 / 页面上没有这个审批：静默忽略。不读 status（只带 status 的事件同样忽略）。
 */
function onApprovalResolved(data) {
  if (!data || typeof data !== "object" || data.decision !== "expired") return;
  const id = data.approvalId;
  if (typeof id !== "string" || !id) return;
  const approvals = Array.isArray(state.approvals) ? state.approvals : [];
  if (approvals.some((item) => item?.id === id)) {
    state.approvals = approvals.filter((item) => item?.id !== id);
    if (state.tab === "approvals" && $("#content")) void renderApprovals({ refetch: false }).catch(() => {});
  }
  const dialog = $("#modal");
  if (state.approvalDialog === id && dialog?.open) {
    state.approvalDialog = null;
    dialog.close();
    toast(APPROVAL_RESOLVED_EXPIRED_TEXT, "info");
  }
}

async function renderSchedules() {
  // Associated catalogues are optional; a reader need not have permission to manage execution identities.
  const [data, agents, accounts] = await Promise.all([
    api("/admin/api/schedules"),
    canPermission("agent.view") ? api("/admin/api/agents") : Promise.resolve({ items: [] }),
    canPermission("service_account.manage") ? api("/admin/api/service-accounts") : Promise.resolve(null),
  ]);
  state.schedules = data.items ?? [];
  state.agents = agents.items ?? [];
  state.serviceAccounts = accounts?.items ?? null;
  state.serviceRoleOptions = accounts?.roleOptions ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>定时任务</h3><p class="muted">重复周期与时区</p></div><div class="actions">${state.serviceAccounts ? `<button class="btn ghost" onclick="app.openServiceAccountCreate()">新建服务账号</button>` : ""}${canPermission("schedule.manage") && canPermission("agent.view") && canPermission("service_account.manage") ? `<button class="btn primary" onclick="app.openScheduleCreate()">新建定时任务</button>` : ""}</div></div>
      ${state.schedules.length ? `<div class="table-wrap"><table><thead><tr><th>名称</th><th>Agent</th><th>运行身份</th><th>执行计划</th><th>时区</th><th>下次运行</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${state.schedules.map((schedule) => `<tr><td><strong>${esc(schedule.name)}</strong><div class="muted mono">${esc(schedule.key)}</div></td><td>${esc(schedule.agent_name)}</td><td>${scheduleIdentity(schedule)}</td><td title="${esc(schedule.cron)}">${esc(scheduleReadableTime(schedule.cron))}</td><td>${esc(schedule.timezone)}</td><td>${fmt(schedule.next_run_at)}</td><td>${statusPill(schedule.status)}${scheduleFailure(schedule)}</td><td><div class="actions">${schedule.status === "active" ? `${canPermission("schedule.manage") ? `<button class="btn ghost small" onclick="app.scheduleAction('${esc(schedule.id)}','disable')">停用</button>` : ""}` : `${canPermission("schedule.manage") ? `<button class="btn ghost small" onclick="app.scheduleAction('${esc(schedule.id)}','enable')">启用</button>` : ""}`}${canPermission("schedule.manage") ? `<button class="btn ghost small" onclick="app.openScheduleEdit('${esc(schedule.id)}')">编辑</button>` : ""}${canPermission("schedule.run") ? `<button class="btn ghost small" onclick="app.scheduleAction('${esc(schedule.id)}','run')">立即运行</button>` : ""}</div></td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有定时任务", "选择执行时间和运行身份，定期执行 Agent。")}
    </div>`;
}

function scheduleIdentity(schedule) {
  if (!schedule.serviceAccountId) return `<span class="muted">服务身份（旧任务）</span>`;
  const account = (state.serviceAccounts ?? []).find((item) => item.id === schedule.serviceAccountId);
  if (!account) return `<span class="mono" title="${esc(schedule.serviceAccountId)}">${esc(schedule.serviceAccountId.slice(0, 8))}</span>`;
  const disabled = account.status !== "active" ? ` <span class="muted">（已停用）</span>` : "";
  return `${esc(account.name)}${disabled}<div class="muted mono">${esc(account.role)} · ${esc(account.dataScope)}</div>`;
}

function scheduleFailure(schedule) {
  if (!schedule.failureCount && !schedule.lastErrorCode) return "";
  const reason = schedule.lastErrorCode === "SCD-4801" ? "服务账号已停用或不存在，任务已暂停" : "最近一次触发失败";
  const count = schedule.failureCount ? `，连续失败 ${schedule.failureCount} 次` : "";
  return `<div class="muted" style="margin-top:4px">${reason}${count}${schedule.lastErrorCode ? `（${esc(schedule.lastErrorCode)}）` : ""}</div>`;
}

async function renderApps() {
  const data = await api("/admin/api/apps");
  state.apps = data.items ?? [];
  $("#content").innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3>开放平台应用</h3><p class="muted">API Key、Scope、配额与 Webhook</p></div>${data.canCreate ? `<button class="btn primary" onclick="app.openAppCreate()">创建应用</button>` : ""}</div>
      ${state.apps.length ? `<div class="table-wrap"><table><thead><tr><th>Key</th><th>名称</th><th>Scopes</th><th>限额</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${state.apps.map((app) => `<tr><td class="mono">${esc(app.key)}</td><td>${esc(app.name)}</td><td class="mono">${esc((app.scopes ?? []).join(", "))}</td><td>${app.rateLimitPerMinute}/min · ${app.dailyQuota}/日</td><td>${statusPill(app.status)}</td><td><div class="actions">${app.canManage ? `<button class="btn primary small" onclick="app.createAppKey('${esc(app.id)}')">新建密钥</button>` : ""}<button class="btn ghost small" onclick="app.listAppKeys('${esc(app.id)}')">查看密钥</button>${app.canManage ? `<button class="btn ghost small" onclick="app.openAppEdit('${esc(app.id)}')">编辑</button>` : ""}</div></td></tr>`).join("")}
      </tbody></table></div>` : empty("还没有应用", "创建应用和 API Key，即可通过 /open/v1 调用 Agent。")}
    </div>`;
}

function canPermission(permission) {
  const permissions = state.session?.permissions ?? [];
  return permissions.includes("*") || permissions.includes(permission);
}
const ROLE_LABELS = { platform_admin: "平台管理员", org_admin: "组织管理员", builder: "开发者", operator: "运营人员", auditor: "审计人员", user: "普通用户" };
const SCOPE_LABELS = { all: "全部", org: "本部门及下级", self: "本人" };
const PERMISSION_DOMAINS = { agent:"Agent",skill:"Skill",mcp:"MCP",tool:"工具",model:"模型",run:"运行",approval:"审批",schedule:"定时任务",apikey:"应用与密钥",plugin:"能力包",package:"能力包",user:"账号",role:"功能权限",org:"组织部门",service_account:"服务账号",sso:"SSO",secret:"凭据",audit:"操作日志",usage:"用量" };
const PERMISSION_ACTIONS = { view:"查看",manage:"管理",publish:"发布",run:"运行",cancel:"取消",decide:"处理",install:"安装",uninstall:"卸载" };
function permissionName(code) {
  if (code === "*") return "全部权限";
  const [domain, action] = code.split(".");
  return `${PERMISSION_DOMAINS[domain] ?? domain} · ${PERMISSION_ACTIONS[action] ?? action}`;
}
function accountTabs(section) {
  return `<nav class="actions account-tabs" aria-label="账号与权限">${canPermission("user.view") ? `<button class="btn ${section === "accounts" ? "primary" : "ghost"}" ${section === "accounts" ? 'aria-current="page"' : ""} onclick="app.switchTab('users')">账号</button>` : ""}${canPermission("role.view") ? `<button class="btn ${section === "roles" ? "primary" : "ghost"}" ${section === "roles" ? 'aria-current="page"' : ""} onclick="app.switchTab('users/roles')">功能权限</button>` : ""}</nav>`;
}
function permissionFields(catalog, selected) {
  const domains = [...new Set(catalog.map(item => item.domain))];
  return `<div class="permission-matrix">${domains.map(domain => `<fieldset><legend>${esc(PERMISSION_DOMAINS[domain] ?? domain)}</legend>${catalog.filter(item => item.domain === domain).map(item => `<label class="permission-choice"><input type="checkbox" name="permissions" value="${esc(item.key)}" ${selected.includes(item.key) ? "checked" : ""}/><span>${esc(permissionName(item.key))}</span></label>`).join("")}</fieldset>`).join("")}</div>`;
}
function additionalRolesField(options, selected, primary) {
  const choices = options.filter(role => role.key !== "platform_admin");
  return `<fieldset class="additional-roles"><legend>附加角色</legend>${choices.length ? choices.map(role => `<label class="permission-choice"><input type="checkbox" name="additionalRoleIds" data-role-key="${esc(role.key)}" value="${esc(role.id)}" ${selected.includes(role.id) && role.key !== primary ? "checked" : ""} ${role.key === primary ? "disabled" : ""}/><span>${esc(role.name)}${role.status === "active" ? "" : "（停用）"}</span></label>`).join("") : '<span class="muted">无</span>'}</fieldset>`;
}
function bindRoleFields() {
  const primary = $("#modal-form select[name=role]");
  if (!primary) return;
  const sync = () => $("#modal-form").querySelectorAll('[name="additionalRoleIds"]').forEach(input => {
    input.disabled = input.dataset.roleKey === primary.value;
    if (input.disabled) input.checked = false;
  });
  primary.addEventListener("change", sync); sync();
}
async function renderRoles() {
  const request = (state.roleRequest ?? 0) + 1; state.roleRequest = request;
  const data = await api("/admin/api/roles");
  if (state.roleRequest !== request || state.tab !== "users" || state.accountSection !== "roles") return;
  state.roles = data.items; state.permissionCatalog = data.catalog;
  $("#content").innerHTML = `${accountTabs("roles")}<div class="card"><div class="card-head"><h3>功能权限</h3>${data.canCreate ? '<button class="btn primary" onclick="app.openRole()">新增角色</button>' : ""}</div>${data.items.length ? `<div class="table-wrap"><table class="roles-table"><thead><tr><th>角色</th><th>类型</th><th>状态</th><th>权限数</th><th>操作</th></tr></thead><tbody>${data.items.map(role => `<tr><td>${esc(role.name)}<div class="muted mono">${esc(role.key)}</div></td><td>${role.builtin ? "内置" : "自定义"}</td><td>${statusPill(role.status, role.status === "active" ? "启用" : "停用")}</td><td>${role.permissions.includes("*") ? "全部" : role.permissions.length}</td><td><div class="actions"><button class="btn ghost small" data-role-action="preview" data-id="${esc(role.id)}">权限预览</button>${role.can_manage ? `<button class="btn ghost small" data-role-action="edit" data-id="${esc(role.id)}">编辑</button>` : ""}${role.can_copy ? `<button class="btn ghost small" data-role-action="copy" data-id="${esc(role.id)}">复制</button>` : ""}${role.can_reset ? `<button class="btn ghost small" data-role-action="reset" data-id="${esc(role.id)}">恢复内置权限</button>` : ""}${role.can_manage && !role.builtin ? `<button class="btn danger small" data-role-action="delete" data-id="${esc(role.id)}">删除</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div>` : '<div class="card-body muted">暂无角色</div>'}</div>`;
  $("#content").querySelectorAll("[data-role-action]").forEach(button => { button.onclick = () => app.roleAction(button.dataset.id,button.dataset.roleAction).catch(error => toast(errorText(error),"error")); });
}
async function afterRoleSave() {
  try {
    state.session = await api("/auth/session", { auth:"probe" });
    await app.switchTab(routeAfterLogin(location.hash.slice(1)));
  } catch (error) { toast(`配置已保存，刷新失败：${errorText(error)}`, "error"); }
}
function listQuery(filters) {
  return new URLSearchParams(Object.entries(filters).filter(([key, value]) => key !== "history" && value !== "").map(([key,value]) => [key, ["from","to"].includes(key) ? new Date(value).toISOString() : value]).concat([["limit", "50"]])).toString();
}
function pagination(kind, result) {
  const filters = state[`${kind}Filters`];
  return `<div class="actions list-pagination"><button class="btn ghost small" ${filters.history.length ? "" : "disabled"} data-page="previous">上一页</button><button class="btn ghost small" ${result.nextCursor ? "" : "disabled"} data-page="next">下一页</button></div>`;
}
function bindPagination(kind, result, render) {
  const buttons = [...$("#content").querySelectorAll("[data-page]")];
  let pending = false;
  buttons.forEach(button => { button.onclick = async () => {
    if (pending) return;
    pending = true;
    const filters = state[`${kind}Filters`];
    const before = { cursor: filters.cursor, history: [...filters.history] };
    const requestKey = `${kind}Request`;
    const expectedRequest = (state[requestKey] ?? 0) + 1;
    const disabled = buttons.map(item => item.disabled);
    buttons.forEach(item => { item.disabled = true; });
    if (button.dataset.page === "next") { filters.history.push(filters.cursor); filters.cursor = result.nextCursor; }
    else filters.cursor = filters.history.pop() ?? "";
    try { await render(); }
    catch (error) { if (state[requestKey] === expectedRequest) { Object.assign(filters, before); toast(errorText(error), "error"); } }
    finally { pending = false; buttons.forEach((item, index) => { item.disabled = disabled[index]; }); }
  }; });
}
async function renderUsers() {
  const request = (state.userRequest ?? 0) + 1; state.userRequest = request;
  const data = await api(`/admin/api/users?${listQuery({ ...state.userFilters })}`);
  if (request !== state.userRequest || state.tab !== "users" || state.accountSection === "roles") return;
  state.users = data.items ?? [];
  state.grantableRoles = data.grantableRoles ?? [];
  state.roleOptions = data.roleOptions ?? [];
  const f = state.userFilters;
  $("#content").innerHTML = `${accountTabs("accounts")}<div class="card">
    <div class="card-head"><h3>账号</h3><div class="actions">${data.canCreate ? '<button class="btn primary" onclick="app.openUser()">新增账号</button>' : ""}</div></div>
    <form id="user-filters" class="card-body actions"><label>搜索<input name="q" value="${esc(f.q)}" maxlength="255" /></label>${select("状态", "status", [{ value: "", label: "全部" }, { value: "active", label: "启用" }, { value: "disabled", label: "停用" }], f.status)}<button class="btn ghost">查询</button></form>
    ${state.users.length ? `<div class="table-wrap"><table class="account-table"><thead><tr><th>登录名</th><th>账号</th><th>角色</th><th>数据范围</th><th>状态</th><th>操作</th></tr></thead><tbody>${state.users.map(user => `<tr><td>${esc(user.username)}</td><td>${esc(user.display_name)}<div class="muted">${esc(user.email)}</div></td><td>${esc((user.roles ?? []).map(role => role.name).join("、") || ROLE_LABELS[user.role] || user.role)}</td><td>${esc(SCOPE_LABELS[user.data_scope] ?? user.data_scope)}</td><td>${statusPill(user.status, user.status === "active" ? "启用" : "停用")}</td><td><div class="actions account-actions"><button class="btn ghost small" data-user-action="detail" data-id="${esc(user.id)}">详情</button>${user.can_manage ? `<details class="account-more"><summary class="btn ghost small" aria-label="「${esc(user.username)}」更多操作">更多</summary><div class="account-menu"><button class="btn ghost small" data-user-action="edit" data-id="${esc(user.id)}">编辑</button><button class="btn ghost small" data-user-action="password" data-id="${esc(user.id)}">重置密码</button><button class="btn ghost small" data-user-action="sessions" data-id="${esc(user.id)}">撤销会话</button>${state.session.user.role === "platform_admin" && canPermission("sso.manage") ? `<button class="btn ghost small" data-user-action="binding" data-id="${esc(user.id)}">SSO绑定</button>` : ""}<button class="btn danger small" data-user-action="delete" data-id="${esc(user.id)}">删除</button></div></details>` : ""}</div></td></tr>`).join("")}</tbody></table></div>` : '<div class="card-body muted">没有匹配的账号</div>'}
    ${pagination("user", data)}</div>`;
  $("#user-filters").onsubmit = async event => { event.preventDefault(); const form = new FormData(event.target); Object.assign(f, { q: String(form.get("q")).trim(), status: String(form.get("status")), cursor: "", history: [] }); await renderUsers().catch(error => toast(errorText(error), "error")); };
  $("#content").querySelectorAll(".account-more").forEach(menu => { menu.onkeydown = event => {
    if (event.key !== "Escape" || !menu.open) return;
    event.preventDefault();
    menu.open = false;
    menu.querySelector("summary").focus();
  }; });
  $("#content").querySelectorAll("[data-user-action]").forEach(button => { button.onclick = () => {
    const menu = button.closest(".account-more");
    if (menu) { menu.open = false; menu.querySelector("summary").focus(); }
    return app.userAction(button.dataset.id, button.dataset.userAction).catch(error => toast(errorText(error), "error"));
  }; });
  bindPagination("user", data, renderUsers);
}

async function renderAudit() {
  const request = (state.auditRequest ?? 0) + 1; state.auditRequest = request;
  const data = await api(`/admin/api/audit?${listQuery({ ...state.auditFilters })}`);
  if (request !== state.auditRequest) return;
  const f = state.auditFilters;
  $("#content").innerHTML = `<div class="card"><div class="card-head"><h3>操作日志</h3></div>
    <form id="audit-filters" class="card-body form-grid">${field("操作", "action", f.action, "text", 'maxlength="64"')}${field("资源类型", "resourceType", f.resourceType, "text", 'maxlength="32"')}${field("资源ID", "resourceId", f.resourceId, "text", 'maxlength="26"')}${field("操作人ID", "actorId", f.actorId, "text", 'maxlength="26"')}${select("结果", "outcome", [{value:"",label:"全部"},{value:"success",label:"成功"},{value:"failure",label:"失败"},{value:"denied",label:"拒绝"}], f.outcome)}${field("开始时间", "from", f.from ? f.from.slice(0,16) : "", "datetime-local")}${field("结束时间", "to", f.to ? f.to.slice(0,16) : "", "datetime-local")}<div class="full"><button class="btn ghost">查询</button></div></form>
    ${data.items.length ? `<div class="table-wrap"><table class="audit-table"><thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>资源</th><th>结果</th><th>操作</th></tr></thead><tbody>${data.items.map(item => `<tr><td>${esc(fmt(item.created_at))}</td><td>${esc(item.actor_name ?? item.actor_id ?? item.actor_type)}</td><td>${esc(item.action)}</td><td>${esc(item.resource_type)}<div class="muted mono">${esc(item.resource_id)}</div></td><td>${esc({success:"成功",failure:"失败",denied:"拒绝"}[item.outcome] ?? item.outcome)}</td><td><button class="btn ghost small" data-audit-id="${esc(item.id)}">详情</button></td></tr>`).join("")}</tbody></table></div>` : '<div class="card-body muted">没有匹配的记录</div>'}${pagination("audit", data)}</div>`;
  $("#audit-filters").onsubmit = async event => { event.preventDefault(); const form = new FormData(event.target); for (const key of ["action","resourceType","resourceId","actorId","outcome","from","to"]) f[key] = String(form.get(key) ?? "").trim(); f.cursor = ""; f.history = []; await renderAudit().catch(error => toast(errorText(error), "error")); };
  $("#content").querySelectorAll("[data-audit-id]").forEach(button => { button.onclick = async () => {
    try { const item = await api(`/admin/api/audit/${idSeg(button.dataset.auditId)}`); openModal("操作日志", `<div class="kv"><span>操作人</span><strong>${esc(item.actor_name ?? item.actor_id ?? item.actor_type)}</strong></div><div class="kv"><span>操作人ID</span><strong class="mono">${esc(item.actor_id)}</strong></div><div class="kv"><span>操作</span><strong>${esc(item.action)}</strong></div><pre class="code-block">${json(item.details_json)}</pre>`, async () => {}, "关闭"); } catch (error) { toast(errorText(error), "error"); }
  }; });
  bindPagination("audit", data, renderAudit);
}

async function renderSso() {
  const data = await api("/admin/api/sso");
  state.roleMappings = data.mappings ?? [];
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

/** FE-XSS-01：名字按 id 从 state 取（只用于 textContent 标题），找不到就退回 id。 */
function agentNameById(id) {
  return state.agents.find((agent) => agent.id === id)?.name ?? id;
}

/**
 * FE-XSS-01：试运行/新版本不再用内联 onclick 拼名字（esc 的 &#39; 在属性里会被解码回 '，可注入）。
 * 改为 data-action + data-agent-id，在不会被替换的 #content 上委托；只挂一次。
 */
let agentActionsBound = false;
function bindAgentActions() {
  if (agentActionsBound) return;
  agentActionsBound = true;
  const content = $("#content");
  content.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-action][data-agent-id]") : null;
    if (!button || !content.contains(button)) return;
    const id = button.dataset.agentId;
    if (button.dataset.action === "agent-run") app.openAgentRun(id);
    else if (button.dataset.action === "agent-new-version") app.openAgentNewVersion(id);
    else if (button.dataset.action === "agent-detail") { event.preventDefault(); app.switchTab(`agents/${encodeURIComponent(id)}`); }
  });
}

function openModal(title, body, onSubmit, submitLabel = "保存", danger = false) {
  const dialog = $("#modal");
  const trigger = dialog.ownerDocument?.activeElement;
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = body;
  const submit = $("#modal-submit");
  submit.textContent = submitLabel;
  submit.className = `btn ${danger ? "danger" : "primary"}`;
  submit.type = "submit";
  const form = $("#modal-form");
  let submitting = false;
  bindConfigurationFields(form);
  const initialValues = new Map([...form.querySelectorAll("input, textarea, select")].map(input => [input, [input.value, input.checked]]));
  const requestClose = () => {
    if (submitting) return;
    const changed = [...initialValues].some(([input, [value, checked]]) => input.value !== value || input.checked !== checked);
    if (changed && !confirm("有未保存的修改，确定放弃吗？")) return;
    dialog.close();
  };
  const closeButtons = form.querySelectorAll('button[value="cancel"]');
  closeButtons.forEach((button) => {
    button.type = "button";
    button.onclick = requestClose;
  });
  dialog.oncancel = (event) => { event.preventDefault(); requestClose(); };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    submit.disabled = true;
    closeButtons.forEach((button) => { button.disabled = true; });
    try {
      // onSubmit 返回 false 表示表单内校验未通过：保持弹窗打开（例如试运行输入为空）。
      if ((await onSubmit(new FormData(form))) === false) return;
      dialog.close();
    } catch (error) {
      toast(errorText(error), "error");
      const field = error.details?.field;
      if (typeof field === "string") {
        const input = form.querySelector(`[name="${CSS.escape(field)}"]`);
        if (input) { input.setAttribute("aria-invalid", "true"); input.focus(); input.addEventListener("input", () => input.removeAttribute("aria-invalid"), { once: true }); }
      }
    } finally {
      submitting = false;
      submit.disabled = false;
      closeButtons.forEach((button) => { button.disabled = false; });
    }
  };
  const credentialInputs = form.querySelectorAll("[data-credential-input]");
  if (credentialInputs.length) dialog.addEventListener("close", () => { form.querySelectorAll("[data-credential-input]").forEach(input => { input.value = ""; }); }, { once: true });
  dialog.addEventListener("close", () => {
    if (!dialog.open) initialValues.clear();
    // A successful save may replace the original trigger when the page re-renders.
    if (trigger && !trigger.isConnected) ($("#content .card-head button") ?? $("#refresh"))?.focus();
  }, { once: true });
  dialog.showModal();
}

function recordValueFields(value, credential = false, secret = false) {
  if (secret) return `<label>凭据<select data-record-value data-secret-picker required><option value="${esc(value)}">${value ? "当前已绑定凭据" : "请选择凭据"}</option></select></label>`;
  if (value !== null && typeof value === "object") return `<div data-record-children data-record-array="${Array.isArray(value)}">${Object.entries(value).map(([key, item]) => recordRow(key, item, credential)).join("")}<button type="button" class="btn ghost small" data-record-add>添加${Array.isArray(value) ? "一项" : "字段"}</button></div>`;
  if (typeof value === "boolean") return `<label>字段值<select data-record-value><option value="true"${value ? " selected" : ""}>是</option><option value="false"${!value ? " selected" : ""}>否</option></select></label>`;
  if (value === null) return `<span class="hint">空值</span>`;
  return `<label>字段值<input data-record-value type="${credential ? "password" : typeof value === "number" ? "number" : "text"}"${typeof value === "number" ? ' step="any" required' : ""} value="${esc(value)}"${credential ? ' data-credential-input autocomplete="new-password"' : ""} /></label>`;
}

function recordRow(key, value, credential = false, secret = false) {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return `<div data-record-row class="config-row"><div class="config-row-head"><label>字段名称<input data-record-key value="${esc(key)}" required /></label>${!credential && !secret ? `<label>数据格式<select data-record-type>${Object.entries({string:"文本",number:"数字",boolean:"是／否",object:"字段组",array:"列表",null:"空值"}).map(([key,label]) => `<option value="${key}"${key === type ? " selected" : ""}>${label}</option>`).join("")}</select></label>` : `<input type="hidden" data-record-type value="string" />`}<button type="button" class="btn ghost small" data-record-remove aria-label="删除字段">删除</button></div><div data-record-content>${recordValueFields(value, credential, secret)}</div></div>`;
}

function recordFields(label, name, value = {}, options = {}) {
  return `<fieldset class="config-fields" data-record-editor data-record-name="${esc(name)}" data-record-credential="${!!options.credential}" data-record-secret="${!!options.secret}" data-record-header="${!!options.header}"><legend>${esc(label)}</legend><input type="hidden" name="${esc(name)}" value="${esc(options.optional ? "" : JSON.stringify(value))}"${options.credential ? " data-credential-input" : ""} />${options.optional ? `<label class="config-check"><input type="checkbox" data-record-replace />替换已有值（空列表表示清除全部值）</label>` : ""}<fieldset data-record-body${options.optional ? " hidden disabled" : ""}><div data-record-children data-record-array="false">${Object.entries(value).map(([key,item]) => recordRow(key,item,options.credential,options.secret)).join("")}<button type="button" class="btn ghost small" data-record-add>添加字段</button></div></fieldset><p class="hint" role="alert" data-record-error hidden></p></fieldset>`;
}

function readRecordRows(container, header = false) {
  const rows = [...container.children].filter(node => node.hasAttribute("data-record-row")), seen = new Set();
  const values = rows.map((row, index) => {
    const keyInput = row.querySelector("[data-record-key]"), key = keyInput.value.trim(), type = row.querySelector("[data-record-type]").value;
    const duplicate = header ? key.toLowerCase() : key;
    if (container.dataset.recordArray !== "true" && (!key || ["__proto__", "prototype", "constructor"].includes(key) || seen.has(duplicate))) throw new Error("字段名称不能为空、重复或使用保留名称");
    if (header && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key)) throw new Error("请求头名称格式不正确");
    seen.add(duplicate);
    const content = row.querySelector("[data-record-content]"), input = content.querySelector("[data-record-value]");
    let value;
    if (type === "object" || type === "array") value = readRecordRows(content.querySelector("[data-record-children]"));
    else if (type === "null") value = null;
    else if (type === "boolean") value = input.value === "true";
    else if (type === "number") { if (!input.value.trim() || !Number.isFinite(Number(input.value))) throw new Error("请填写有效数字"); value = Number(input.value); }
    else { value = input.value; if (input.hasAttribute("data-secret-picker") && !value) throw new Error("请选择凭据"); }
    return [container.dataset.recordArray === "true" ? index : key, value];
  });
  return container.dataset.recordArray === "true" ? values.map(([,value]) => value) : Object.fromEntries(values);
}

function scheduleCronParts(cron) {
  const match = /^(\d+) (\d+|\*) (\d+|\*) \* (\d+|\*)$/.exec(cron);
  if (!match) return { period:"custom", time:"09:00", day:"1", weekday:"1" };
  const [, minute, hour, day, weekday] = match;
  if (Number(minute)>59 || hour!=="*" && Number(hour)>23 || day!=="*" && (Number(day)<1 || Number(day)>31) || weekday!=="*" && Number(weekday)>6 || day!=="*" && weekday!=="*" || hour==="*" && (day!=="*" || weekday!=="*")) return { period:"custom", time:"09:00", day:"1", weekday:"1" };
  return { period:hour==="*"?"hourly":day!=="*"?"monthly":weekday!=="*"?"weekly":"daily", time:`${hour==="*"?"00":hour.padStart(2,"0")}:${minute.padStart(2,"0")}`, day:day==="*"?"1":day, weekday:weekday==="*"?"1":weekday };
}

function scheduleReadableTime(cron) {
  const part=scheduleCronParts(cron);
  if(part.period==="custom")return "自定义计划";
  if(part.period==="hourly")return `每小时第 ${Number(part.time.split(":")[1])} 分钟`;
  if(part.period==="weekly")return `每周${["日","一","二","三","四","五","六"][Number(part.weekday)]} ${part.time}`;
  if(part.period==="monthly")return `每月 ${part.day} 日 ${part.time}`;
  return `每天 ${part.time}`;
}

function scheduleCronValue(period, time, day, weekday, custom) {
  if (period === "custom") return custom;
  const [hour, minute] = time.split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour<0 || hour>23 || minute<0 || minute>59) throw new Error("请选择有效的执行时间");
  if (period === "monthly" && (!/^\d+$/.test(day) || Number(day)<1 || Number(day)>31)) throw new Error("每月日期须为 1–31");
  if (period === "weekly" && !/^[0-6]$/.test(weekday)) throw new Error("请选择星期");
  return `${minute} ${period==="hourly"?"*":hour} ${period==="monthly"?Number(day):"*"} * ${period==="weekly"?weekday:"*"}`;
}

function scheduleFields(cron = "0 9 * * *", timezone = "Asia/Shanghai") {
  const parts = scheduleCronParts(cron);
  return `<fieldset class="full config-schedule"><legend>执行时间</legend><input type="hidden" name="cron" value="${esc(cron)}" /><div class="form-grid">${select("重复周期", "repeatPeriod", [{value:"daily",label:"每天"},{value:"weekly",label:"每周"},{value:"monthly",label:"每月"},{value:"hourly",label:"每小时"},{value:"custom",label:"自定义计划（高级）"}], parts.period)}${field("执行时间", "repeatTime", parts.time, "time", 'required data-cron-time')}${field("每小时第几分钟", "repeatMinute", String(Number(parts.time.split(":")[1])), "number", 'min="0" max="59" required')}${select("星期", "repeatWeekday", [1,2,3,4,5,6,0].map((value,index)=>({value:String(value),label:["星期一","星期二","星期三","星期四","星期五","星期六","星期日"][index]})), parts.weekday)}${field("每月几日", "repeatDay", parts.day, "number", 'min="1" max="31" data-cron-day')}${select("时区", "timezone", [{value:"Asia/Shanghai",label:"北京时间"},{value:"UTC",label:"协调世界时（UTC）"},...([...new Set([timezone,...Intl.supportedValuesOf("timeZone")])]).filter(value=>value!=="Asia/Shanghai"&&value!=="UTC").map(value=>({value,label:value}))], timezone)}</div><div data-cron-custom>${field("Cron 表达式", "customCron", cron)}</div><p class="hint" data-cron-hint></p></fieldset>`;
}

function bindConfigurationFields(form) {
  form.querySelectorAll("[data-app-scope-fields]").forEach(group=>{
    const sync=()=>{group.querySelector('[name="scopes"]').value=[...group.querySelectorAll('[data-app-scope]:checked')].map(input=>input.value).join(",");};
    group.addEventListener("change",sync);
    const input=group.querySelector('[data-scope-new]');input.addEventListener("input",()=>input.setCustomValidity(""));
    group.querySelector('[data-scope-add]').addEventListener("click",()=>{try{const value=validateAppScope(input.value,[...group.querySelectorAll('[data-app-scope]')].map(item=>item.value));group.querySelector('.config-scope-list').insertAdjacentHTML("beforeend",`<label class="config-check"><input type="checkbox" data-app-scope value="${esc(value)}" checked />${esc(value)}</label>`);input.value="";input.setCustomValidity("");sync();}catch(error){input.setCustomValidity(error.message);input.reportValidity();}});
  });
  form.querySelectorAll("[data-record-editor]").forEach(editor => {
    const hidden = editor.querySelector('input[type="hidden"][name]'), body = editor.querySelector("[data-record-body]"), replace = editor.querySelector("[data-record-replace]");
    const sync = () => {
      editor.querySelectorAll('[data-record-array="true"]').forEach(container=>[...container.children].filter(node=>node.hasAttribute("data-record-row")).forEach((row,index)=>{const key=row.querySelector("[data-record-key]");key.value=String(index);key.readOnly=true;}));
      if (replace) { body.hidden = !replace.checked; body.disabled = !replace.checked; }
      const error = editor.querySelector("[data-record-error]");
      const control = editor.querySelector("[data-record-key]") ?? replace;
      try { hidden.value = replace && !replace.checked ? "" : JSON.stringify(readRecordRows(body.querySelector("[data-record-children]"),editor.dataset.recordHeader==="true")); if(control)control.setCustomValidity(""); error.hidden = true; }
      catch (err) { if(control)control.setCustomValidity(err.message); error.textContent = err.message; error.hidden = false; }
    };
    editor.addEventListener("click", event => {
      const remove = event.target.closest("[data-record-remove]"), add = event.target.closest("[data-record-add]");
      if (remove) remove.closest("[data-record-row]").remove();
      if (add) { const container = add.parentElement, key = container.dataset.recordArray==="true"?String(container.querySelectorAll(":scope > [data-record-row]").length):""; add.insertAdjacentHTML("beforebegin",recordRow(key,"",editor.dataset.recordCredential==="true",editor.dataset.recordSecret==="true")); loadSecretPickers(editor); container.querySelector(":scope > [data-record-row]:last-of-type [data-record-key]")?.focus(); }
      if(remove||add)sync();
    });
    editor.addEventListener("change", event => {
      if(event.target.matches("select[data-record-type]")) { const defaults={string:"",number:0,boolean:false,object:{},array:[],null:null}; event.target.closest("[data-record-row]").querySelector("[data-record-content]").innerHTML=recordValueFields(defaults[event.target.value]); }
      sync();
    });
    editor.addEventListener("input", sync);
  });
  form.querySelectorAll(".config-schedule").forEach(editor => {
    const update = () => {
      const get = name => editor.querySelector(`[name="${name}"]`), period = get("repeatPeriod").value, time = get("repeatTime"), minute = get("repeatMinute");
      time.closest("label").hidden=period==="custom"||period==="hourly";time.disabled=period==="custom"||period==="hourly";
      minute.closest("label").hidden=period!=="hourly";minute.disabled=period!=="hourly";time.setCustomValidity("");minute.setCustomValidity("");
      get("repeatWeekday").closest("label").hidden=period!=="weekly";get("repeatWeekday").disabled=period!=="weekly";
      get("repeatDay").closest("label").hidden=period!=="monthly";get("repeatDay").disabled=period!=="monthly";
      editor.querySelector("[data-cron-custom]").hidden=period!=="custom";get("customCron").disabled=period!=="custom";
      const hint=editor.querySelector("[data-cron-hint]");
      try {get("cron").value=scheduleCronValue(period,period==="hourly"?`00:${minute.value.padStart(2,"0")}`:time.value,get("repeatDay").value,get("repeatWeekday").value,get("customCron").value);time.setCustomValidity("");hint.textContent=period==="monthly"?"当月没有所选日期时，当月不执行。":period==="hourly"?`每小时第 ${Number(minute.value)} 分钟执行。`:"按所选时区执行。";}catch(err){(period==="hourly"?minute:time).setCustomValidity(err.message);hint.textContent=err.message;}
    };
    editor.addEventListener("input",update);editor.addEventListener("change",update);update();
  });
  form.querySelectorAll("[data-import-file]").forEach(input=>{
    input.addEventListener("change",async()=>{
      const file=input.files?.[0],target=form.querySelector(`[name="${input.dataset.importFile}"]`),hint=input.parentElement.querySelector("[data-import-hint]");
      if(!file)return;
      const submit=form.querySelector('[type="submit"]');submit.disabled=true;
      try{const content=await configurationFileText(file);target.value=content;input.setCustomValidity("");hint.textContent=`已读取：${file.name}`;}
      catch(error){target.value="";input.setCustomValidity(error.message);hint.textContent=error.message;}
      finally{if(input.isConnected)submit.disabled=false;}
    });
  });
  loadSecretPickers(form);
}

async function configurationFileText(file) {
  if(file.size>1048576)throw new Error("配置文件不能超过 1 MB");
  const content=await file.text();
  try{const parsed=JSON.parse(content);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error();}catch{throw new Error("请选择包含有效配置对象的 JSON 文件");}
  return content;
}

function configurationImportField(label,name) {
  return `<div class="full"><label>${esc(label)}<input type="file" accept=".json,application/json" data-import-file="${esc(name)}" /><span class="hint" data-import-hint>选择提供方给出的 JSON 文件，最大 1 MB。</span></label><details class="advanced-config"><summary>高级：粘贴配置文档</summary>${textarea("配置内容",name,"",8)}</details></div>`;
}

async function loadSecretPickers(root) {
  const pickers=[...root.querySelectorAll("[data-secret-picker]")].filter(input=>!input.dataset.loaded);
  if(!pickers.length || !canManageSecrets())return;
  pickers.forEach(input=>{input.dataset.loaded="true";});
  try {
    const items=[];let cursor="";
    do {const page=await api(`/admin/api/secrets?limit=200${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);items.push(...page.items);cursor=page.nextCursor;}while(cursor && root.isConnected);
    for(const input of pickers){if(!input.isConnected)continue;const current=input.value;input.innerHTML=`<option value="">${input.required?'请选择凭据':'不绑定已有凭据'}</option>`+items.filter(item=>item.status==="active" || item.id===current).map(item=>`<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.key)}</option>`).join("");if(current&&!items.some(item=>item.id===current))input.insertAdjacentHTML("beforeend",`<option value="${esc(current)}">当前已绑定凭据（目录不可见）</option>`);input.value=current;}
  } catch {for(const input of pickers)if(input.isConnected){input.dataset.loaded="";input.insertAdjacentHTML("afterend",'<span class="hint" role="alert">凭据目录加载失败，请重新打开表单重试；已有绑定仍会保留。</span>');}}
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

function textarea(label, name, value = "", rows = 6, extra = "") {
  return `<label>${label}<textarea name="${esc(name)}" rows="${rows}"${extra ? ` ${extra}` : ""}>${esc(value)}</textarea></label>`;
}

const APP_SCOPES_HINT_ID = "app-scopes-hint";

/** 应用 Scopes 输入框下的说明：Key 的有效 scope = Key 的 scopes ∩ 应用当前 scopes；新建 Key 复制应用当时的 scopes；不接受含 * 的 scope。 */
function validateAppScope(value, existing) {
  const scope=value.trim();
  if(!scope || scope.length>64 || scope.includes("*"))throw new Error("权限标识须为 1–64 个字符，不能包含通配符");
  if(existing.includes(scope))throw new Error("该权限已在列表中");
  return scope;
}

function appScopeFields(scopes = []) {
  const labels = {"agents:read":"查看 Agent","runs:create":"发起运行","runs:read":"查看运行结果","runs:cancel":"取消运行"};
  const options = [...new Set([...Object.keys(labels),...scopes])];
  return `<fieldset class="full" data-app-scope-fields aria-describedby="${APP_SCOPES_HINT_ID}"><legend>应用可用权限</legend><input type="hidden" name="scopes" value="${esc(scopes.join(","))}" aria-describedby="${APP_SCOPES_HINT_ID}" /><div class="config-scope-list">${options.map(value=>`<label class="config-check"><input type="checkbox" data-app-scope value="${esc(value)}"${scopes.includes(value)?" checked":""} />${esc(labels[value]??`自定义权限：${value}`)}</label>`).join("")}</div><details class="advanced-config"><summary>高级：自定义权限</summary><label>权限标识<input data-scope-new maxlength="64" /></label><button type="button" class="btn ghost small" data-scope-add>添加权限</button></details>${appScopesHint()}</fieldset>`;
}

function appScopesHint() {
  return `<p class="hint" id="${APP_SCOPES_HINT_ID}">${esc("收窄会立即对已有 Key 生效；放宽只对之后新建的 Key 生效，已有 Key 需要重新创建。不支持 ")}<code>*</code>${esc(" 通配。")}</p>`;
}

/** Key 列表 Scopes 列：GET /admin/api/apps/:id/keys 返回 scopes_json（数组）；缺失或不是数组时显示空。 */
function keyScopesText(key) {
  return Array.isArray(key?.scopes_json) ? key.scopes_json.join(", ") : "";
}

function showAppKey(result) {
  const text = result.secretAvailable === false
    ? "轮换已完成，明文密钥已在首次响应中返回。如未保存，请轮换新密钥。"
    : "请立即复制保存，关闭后无法再次查看。";
  openModal("API Key（只显示一次）", `<p class="muted">${text}</p><p>新密钥 Prefix：<span class="mono">${esc(result.prefix)}</span></p>${result.key ? `<div class="code-block api-key-secret">${esc(result.key)}</div>` : ""}`, async () => {}, result.key ? "已保存" : "关闭");
  const secret = $(".api-key-secret");
  if (secret) $("#modal").addEventListener("close", () => { secret.textContent = ""; }, { once: true });
}

/** 表单内字段提示：文案走 textContent，显示提示、标记 aria-invalid 并聚焦；用户改动输入后提示消失。 */
function showFieldError(name, errorId, message) {
  const input = $("#modal-body").querySelector(`[name="${name}"]`);
  const error = $(`#${errorId}`);
  if (error) {
    error.textContent = message;
    error.hidden = false;
  }
  if (!input) return;
  input.setAttribute("aria-invalid", "true");
  input.addEventListener("input", () => {
    input.removeAttribute("aria-invalid");
    if (error) error.hidden = true;
  }, { once: true });
  input.focus();
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

function agentSpecFields(spec) {
  const fields = [["模型 Provider Key", "model.provider", "text", "required list=agent-providers"], ["模型名称", "model.model", "text", "required list=agent-models"], ["温度（可选）", "model.temperature", "number", 'min="0" max="2" step="0.1"'], ["最多执行步数（可选）", "limits.maxSteps", "number", 'min="1" step="1"'], ["成本上限（美元，可选）", "limits.maxCostUsd", "number", 'min="0" step="0.000001"']];
  return fields.map(([label,path,type,extra]) => { const [group,key] = path.split("."); return field(label, path, spec[group]?.[key] ?? "", type, `data-spec-path="${path}" ${extra}`); }).join("") + `
    <datalist id="agent-providers"></datalist><datalist id="agent-models"></datalist>
    <div class="full" data-agent-capabilities><p class="hint">正在加载有权读取的模型、Skill 和工具目录…</p></div>
    <details class="full advanced-config"><summary>高级配置 JSON（与上方字段同步）</summary>${textarea("完整 Agent 配置", "spec", JSON.stringify(spec, null, 2), 10)}<p class="hint" id="agent-spec-error" role="alert" hidden></p></details>`;
}

function agentReadableConfig(spec) {
  const unsupported = "请查看高级配置";
  const strings = value => Array.isArray(value) && value.every(item => typeof item === "string") ? value.join("、") || "无" : value == null ? "无" : unsupported;
  const model = spec.model && typeof spec.model.provider === "string" && typeof spec.model.model === "string" ? `${spec.model.provider} / ${spec.model.model}` : spec.model == null ? "未配置" : unsupported;
  const skills = strings(spec.skills);
  const tools = Array.isArray(spec.toolsets) ? spec.toolsets.map(group => {
    if (!group || typeof group !== "object") return unsupported;
    if (group.builtin !== undefined) return strings(group.builtin);
    const key = group.mcp ?? group.openapi ?? group.connector;
    return typeof key === "string" ? key : unsupported;
  }).join("；") || "无" : spec.toolsets == null ? "无" : unsupported;
  const steps = spec.limits?.maxSteps, cost = spec.limits?.maxCostUsd;
  const budget = [steps,cost].every(value => value == null || typeof value === "number") ? `最多 ${steps ?? "默认"} 步，成本上限 ${cost ?? "默认"} 美元` : unsupported;
  return { model, skills, tools, budget };
}

function editAgentSpec(spec, path, value) {
  if (!["model.provider", "model.model", "model.temperature", "limits.maxSteps", "limits.maxCostUsd"].includes(path)) throw new Error("未知配置字段");
  const next = structuredClone(spec), [group,key] = path.split(".");
  next[group] = next[group] && typeof next[group] === "object" && !Array.isArray(next[group]) ? { ...next[group] } : {};
  if (path === "model.provider" || path === "model.model") next[group][key] = value;
  else if (value === "") delete next[group][key];
  else {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("请输入有效数值");
    next[group][key] = number;
  }
  return next;
}

function chooseAgentCapability(spec, kind, key, checked, previous = []) {
  const next = structuredClone(spec);
  if (kind === "skills") {
    next.skills = (next.skills ?? []).filter(value => value !== key);
    if (checked) next.skills.push(key);
  } else if (kind === "builtin") {
    next.toolsets = (next.toolsets ?? []).map(group => group.builtin ? { ...group, builtin: group.builtin.filter(value => value !== key) } : group).filter(group => !group.builtin || group.builtin.length);
    if (checked) next.toolsets.push({ builtin: [key] });
  } else if (kind === "mcp" || kind === "openapi") {
    const existing = (next.toolsets ?? []).filter(group => group?.[kind] === key);
    next.toolsets = (next.toolsets ?? []).filter(group => group[kind] !== key);
    if (checked) next.toolsets.push(...(existing.length ? existing : previous.length ? structuredClone(previous) : [{ [kind]: key }]));
  } else throw new Error("未知能力类型");
  return next;
}

function bindAgentSpecEditor() {
  const body = $("#modal-body"), raw = body.querySelector('[name="spec"]');
  const controls = [...body.querySelectorAll("[data-spec-path]")];
  const retainedCapabilities = new Map();
  const read = () => { const spec = JSON.parse(raw.value); if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("配置必须是 JSON 对象"); return spec; };
  const report = error => { raw.setCustomValidity(error ? "请修正高级配置 JSON" : ""); const hint = body.querySelector("#agent-spec-error"); hint.hidden = !error; hint.textContent = error ? error.message : ""; if (error) raw.closest("details").open = true; };
  const sync = () => {
    try {
      const spec = read(); report(null);
      for (const control of controls) { const [group,key] = control.dataset.specPath.split("."); control.value = spec[group]?.[key] ?? ""; }
      for (const control of body.querySelectorAll("[data-capability]")) { const { capability: kind, key } = control.dataset; control.checked = kind === "skills" ? Array.isArray(spec.skills) && spec.skills.includes(key) : Array.isArray(spec.toolsets) && spec.toolsets.some(group => kind === "builtin" ? Array.isArray(group?.builtin) && group.builtin.includes(key) : group?.[kind] === key); }
    } catch (error) { report(error); }
  };
  const change = update => { try { raw.value = JSON.stringify(update(read()), null, 2); report(null); } catch (error) { report(error); } };
  for (const control of controls) control.addEventListener("input", () => change(spec => editAgentSpec(spec, control.dataset.specPath, control.value)));
  raw.addEventListener("input", sync);
  const directories = [["model.view", "/admin/api/providers", "models", "模型"], ["skill.view", "/admin/api/skills", "skills", "Skills"], ["mcp.view", "/admin/api/mcp", "mcp", "MCP 服务"], ["tool.view", "/admin/api/tool-sources", "openapi", "OpenAPI 工具源"]].filter(([permission]) => canPermission(permission));
  Promise.allSettled(directories.map(([,path]) => api(path))).then(results => {
    if (!raw.isConnected) return;
    const groups = [{ kind: "builtin", label: "内置工具", items: [{ key: "current_time", name: "当前时间" }, { key: "echo", name: "回显" }] }];
    const errors = [];
    results.forEach((result,index) => {
      const [, , kind, label] = directories[index];
      if (result.status === "rejected") { errors.push(`${label}目录加载失败，可重开表单重试或使用高级配置。`); return; }
      const items = result.value.items ?? [];
      if (kind === "models") {
        body.querySelector("#agent-providers").innerHTML = items.map(item => `<option value="${esc(item.key)}">${esc(item.name)}</option>`).join("");
        body.querySelector("#agent-models").innerHTML = items.flatMap(item => item.models ?? []).map(item => `<option value="${esc(item.key)}">${esc(item.displayName ?? item.key)}</option>`).join("");
      } else groups.push({ kind, label, items });
    });
    body.querySelector("[data-agent-capabilities]").innerHTML = `<p class="hint">模型可按 Key 输入或从目录选择；原有工具白名单与高级配置会保留，新绑定的 MCP / OpenAPI 工具源默认使用其全部工具。</p>${groups.map(group => `<fieldset class="capability-group"><legend>${esc(group.label)}</legend>${group.items.length ? group.items.map(item => `<label class="capability-choice"><input type="checkbox" data-capability="${group.kind}" data-key="${esc(item.key)}" />${esc(item.name ?? item.key)} <span class="muted">${esc(item.key)}</span></label>`).join("") : '<p class="hint">当前没有可选资源</p>'}</fieldset>`).join("")}${errors.map(message => `<p class="hint" role="status">${esc(message)}</p>`).join("")}`;
    for (const control of body.querySelectorAll("[data-capability]")) control.addEventListener("change", () => change(spec => {
      const { capability: kind, key } = control.dataset, identity = `${kind}:${key}`;
      if (!control.checked && (kind === "mcp" || kind === "openapi")) retainedCapabilities.set(identity, (spec.toolsets ?? []).filter(group => group?.[kind] === key));
      return chooseAgentCapability(spec, kind, key, control.checked, retainedCapabilities.get(identity));
    }));
    sync();
  }).catch(error => { if (raw.isConnected) report(error); });
}

function secretResourceDirectories() {
  return { agent: ["Agent", "agent.view", "/admin/api/agents"], llm_provider: ["模型 Provider", "model.view", "/admin/api/providers"], mcp_server: ["MCP 服务", "mcp.view", "/admin/api/mcp"], tool_source: ["OpenAPI 工具源", "tool.view", "/admin/api/tool-sources"], api_app: ["API 应用", "apikey.view", "/admin/api/apps"], message_channel: ["消息渠道", "message.view", "/admin/api/message-channels"] };
}

function bindSecretScopePicker() {
  const body = $("#modal-body"), type = body.querySelector("[name=scopeType]"), resource = body.querySelector("[name=resourceType]");
  const select = body.querySelector("[name=scopeId]"), query = body.querySelector("[name=scopeQuery]"), manual = body.querySelector("[name=scopeManualId]"), hint = body.querySelector("[data-scope-hint]");
  let generation = 0, items = [];
  const filter = () => { const selected = select.value, text = query.value.toLowerCase(); select.innerHTML = '<option value="">请选择对象</option>' + items.filter(item => `${item.name} ${item.key ?? ""} ${item.id}`.toLowerCase().includes(text)).map(item => `<option value="${esc(item.id)}">${esc(item.name ?? item.key ?? item.id)}${item.key ? ` · ${esc(item.key)}` : ""}</option>`).join(""); select.value = selected; hint.textContent = select.value ? `选定对象 ID：${select.value}` : "按名称或 Key 查找并选择对象。"; };
  select.onchange = () => { hint.textContent = select.value ? `选定对象 ID：${select.value}` : "按名称或 Key 查找并选择对象。"; if (select.value) manual.value = ""; };
  query.oninput = filter;
  const update = async () => {
    const request = ++generation, platform = type.value === "platform";
    body.querySelector("[data-secret-resource]").hidden = type.value !== "resource";
    body.querySelector("[data-secret-target]").hidden = platform;
    select.value = ""; manual.value = ""; query.value = ""; items = []; filter();
    select.disabled = true; query.disabled = true; manual.disabled = platform;
    if (platform) return;
    const directory = type.value === "org" ? ["组织", "org.view", "/admin/api/org-units"] : secretResourceDirectories()[resource.value];
    hint.textContent = "正在加载目录…";
    try {
      if (!directory || !canPermission(directory[1])) throw new Error("没有读取此目录的权限，可联系管理员或使用高级 ID 输入。");
      const result = await api(directory[2]);
      if (request !== generation || !select.isConnected) return;
      items = result.items ?? []; filter(); select.disabled = false; query.disabled = false;
      hint.textContent = items.length ? "按名称或 Key 查找并选择对象。" : "目录中没有可选对象，可先创建资源或使用高级 ID 输入。";
    } catch (error) { if (request === generation && select.isConnected) hint.textContent = `目录未加载：${errorText(error)}`; }
  };
  type.onchange = update; resource.onchange = update;
  body.querySelector("[data-scope-retry]").onclick = update;
  update();
}

// ---------- actions ----------

const app = {
  switchTab,
  // 内联 onclick="app.renderCurrent()" 走带 catch 的版本（同 #refresh）
  renderCurrent: refreshCurrent,

  openAgentCreate() {
    const spec = JSON.stringify({ model: { provider: "mock", model: "mock-1", temperature: 0.2 }, toolsets: [{ builtin: ["current_time", "echo"] }], limits: { maxSteps: 4, maxCostUsd: 1 } }, null, 2);
    openModal("新建 Agent", `
      <div class="form-grid">
        ${field("Key", "key", "my-agent")}
        ${field("名称", "name", "我的 Agent")}
        <div class="full">${field("描述", "description", "")}</div>
        <div class="full">${textarea("指令", "instructions", "你是一个简洁、可靠的助手。")}</div>
        ${agentSpecFields(JSON.parse(spec))}
      </div>`, async (data) => {
      const body = {
        key: data.get("key"),
        name: data.get("name"),
        description: data.get("description"),
        instructions: data.get("instructions"),
        spec: parseJsonField(data, "spec", {}),
        publish: false,
      };
      await api("/admin/api/agents", { method: "POST", body });
      toast("Agent 草稿已保存，可先试运行，再单独发布");
      await renderAgents();
    }, "保存草稿");
    bindAgentSpecEditor();
  },

  async openAgentNewVersion(id) {
    const name = agentNameById(id);
    try {
      const detail = await api(`/admin/api/agents/${idSeg(id)}`);
      const latest = detail.versions?.[0];
      if (!latest) throw new Error("Agent 没有版本");
      openModal(`新建版本 · ${name}`, `
        <div class="form-grid">
          ${field("版本号", "version", "1.1.0")}
          <div class="full">${textarea("指令", "instructions", latest.instructions ?? "")}</div>
          ${agentSpecFields(latest.spec_json ?? {})}
        </div>`, async (data) => {
        await api(`/admin/api/agents/${idSeg(id)}/versions`, { method: "POST", headers: revisionHeaders(detail), body: { version: data.get("version"), instructions: data.get("instructions"), spec: parseJsonField(data, "spec", {}), publish: false } });
        toast("新版本草稿已保存，线上版本保持不变");
        await renderAgents();
      }, "保存草稿");
      bindAgentSpecEditor();
    } catch (error) {
      toast(errorText(error), "error");
    }
  },

  secretFirstPage() { return renderSecrets().catch(error => toast(errorText(error), "error")); },
  secretNextPage() { return renderSecrets(state.secretNextCursor).catch(error => toast(errorText(error), "error")); },

  openSecretCreate() {
    openModal("新建凭据", `<div class="form-grid">
      ${field("Key", "key", "", "text", 'required minlength="2" maxlength="64" pattern="[a-z0-9][a-z0-9._-]{1,63}"')}
      ${field("名称", "name", "", "text", 'required maxlength="128"')}
      <div class="full">${textarea("描述", "description", "", 2, 'maxlength="1024"')}</div>
      ${select("作用域", "scopeType", [{value:"platform",label:"平台"},{value:"org",label:"组织"},{value:"resource",label:"指定资源"}], "platform")}
      <div data-secret-resource hidden>${select("资源类型", "resourceType", Object.entries(secretResourceDirectories()).map(([value,[label]]) => ({value,label})))}</div>
      <div class="full" data-secret-target hidden>${field("搜索组织 / 资源名称或 Key", "scopeQuery", "", "search")}${select("选择组织 / 资源", "scopeId", [{value:"",label:"请选择对象"}])}<p class="hint" data-scope-hint role="status"></p><button type="button" class="btn ghost small" data-scope-retry>重新加载目录</button><details class="advanced-config"><summary>高级：直接输入对象 ID</summary>${field("组织 / 资源 ID", "scopeManualId", "", "text", 'minlength="26" maxlength="26"')}<p class="hint">仅在明确知道目标 ID 时使用，保存仍执行服务端作用域校验。</p></details></div>
      <div class="full">${textarea("凭据值", "value", "", 5, 'required autocomplete="off" spellcheck="false" data-credential-input')}</div>
    </div>`, async data => {
      const type = data.get("scopeType"), selected = data.get("scopeId"), manual = data.get("scopeManualId");
      if (type !== "platform" && !selected && !manual) throw new Error("请选择组织或资源，或在高级区填写目标 ID");
      if (selected && manual && selected !== manual) throw new Error("目录选择和高级 ID 不一致，请只保留一个目标");
      const id = selected || manual, scope = type === "platform" ? {type} : type === "org" ? {type,id} : {type,resourceType:data.get("resourceType"),id};
      await api("/admin/api/secrets", {method:"POST",body:{key:data.get("key"),name:data.get("name"),description:data.get("description"),scope,value:data.get("value")}});
      toast("凭据已创建"); await renderSecrets();
    });
    bindSecretScopePicker();
  },

  async openSecretDetail(id) {
    try {
      const secret = await api(`/admin/api/secrets/${idSeg(id)}`);
      openModal(`凭据 · ${secret.name}`, `<dl><dt>ID</dt><dd class="mono">${esc(secret.id)}</dd><dt>作用域</dt><dd>${esc(secretScopeText(secret.scope))}</dd><dt>描述</dt><dd>${esc(secret.description || "—")}</dd><dt>创建时间</dt><dd>${esc(fmt(secret.createdAt))}</dd></dl>
        <h4>版本</h4><div class="table-wrap"><table><thead><tr><th>版本</th><th>主密钥版本</th><th>状态</th><th>创建时间</th></tr></thead><tbody>${secret.versions.map(v => `<tr><td>${v.version}</td><td class="mono">${esc(v.keyVersion)}</td><td>${v.active ? "当前" : "历史"}</td><td>${esc(fmt(v.createdAt))}</td></tr>`).join("")}</tbody></table></div>
        <h4>引用资源</h4>${secret.references.length ? `<div class="table-wrap"><table><thead><tr><th>名称</th><th>类型 / ID</th><th>用途</th></tr></thead><tbody>${secret.references.map(r => `<tr><td>${esc(r.name)}</td><td class="mono">${esc(r.resourceType)}<br>${esc(r.resourceId)}</td><td>${esc(r.bindingKey)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">暂无引用</p>`}`, async () => {}, "关闭");
    } catch (error) { toast(errorText(error), "error"); }
  },

  async openSecretEdit(id) {
    try {
      const secret = await api(`/admin/api/secrets/${idSeg(id)}`);
      openModal(`编辑凭据 · ${secret.name}`, `<div class="form-grid">${field("名称", "name", secret.name, "text", 'required maxlength="128"')}<div class="full">${textarea("描述", "description", secret.description, 3, 'maxlength="1024"')}</div></div>`, async data => {
        await api(`/admin/api/secrets/${idSeg(id)}`, {method:"PATCH",headers:revisionHeaders(secret),body:{name:data.get("name"),description:data.get("description")}});
        toast("凭据已更新"); await renderSecrets();
      });
    } catch (error) { toast(errorText(error), "error"); }
  },

  openSecretRotate(id) {
    const secret = state.secrets.find(item => item.id === id); if (!secret) return;
    openModal(`轮换凭据 · ${secret.name}`, textarea("新凭据值", "value", "", 5, 'required autocomplete="off" spellcheck="false" data-credential-input'), async data => {
      await api(`/admin/api/secrets/${idSeg(id)}/rotate`, {method:"POST",headers:revisionHeaders(secret),body:{value:data.get("value")}});
      toast("凭据已轮换"); await renderSecrets();
    }, "轮换");
  },

  setSecretStatus(id) {
    const secret = state.secrets.find(item => item.id === id); if (!secret) return;
    const status = secret.status === "active" ? "disabled" : "active", label = status === "active" ? "启用" : "停用";
    openModal(`${label}凭据`, `<p>${esc(secret.name)}${status === "disabled" ? "：停用后新请求将无法使用该凭据。" : ""}</p>`, async () => {
      await api(`/admin/api/secrets/${idSeg(id)}`, {method:"PATCH",headers:revisionHeaders(secret),body:{status}});
      toast(`凭据已${label}`); await renderSecrets();
    }, label, status === "disabled");
  },

  deleteSecret(id) {
    const secret = state.secrets.find(item => item.id === id); if (!secret) return;
    openModal("删除凭据", `<p>确认删除「${esc(secret.name)}」？</p>`, async () => {
      await api(`/admin/api/secrets/${idSeg(id)}`, {method:"DELETE",headers:revisionHeaders(secret)});
      toast("凭据已删除"); await renderSecrets();
    }, "删除", true);
  },

  openMcpEdit(id) {
    const server = state.mcp.find((item) => item.id === id);
    if (!server) return;
    openModal("编辑 MCP", `
      <div class="form-grid">
        ${field("名称", "name", server.name)}
        <div class="full">${field("HTTP URL", "url", server.url)}</div>
        ${credentialHeaderFields(server)}
      </div>`, async (data) => {
      const saved = await api(`/admin/api/mcp/${idSeg(id)}`, { method: "PATCH", headers: revisionHeaders(server), body: { name: data.get("name"), url: data.get("url"), ...credentialHeadersChange(data, server) } });
      server.revision = saved.revision;
      await api(`/admin/api/mcp/${idSeg(id)}/refresh`, { method: "POST", headers: revisionHeaders(server), body: {} });
      toast("MCP 已更新");
      await renderMcp();
    });
  },

  async openSkillEdit(id) {
    try {
      const skill = await api(`/admin/api/skills/${idSeg(id)}`);
      const latest = skill.versions?.[0];
      openModal(`编辑 Skill · ${skill.name}`, `
        <div class="form-grid">
          ${field("名称", "name", skill.name)}
          ${field("新版本号", "version", "1.0.1")}
          <div class="full">${field("描述", "description", skill.description)}</div>
          <div class="full">${textarea("SKILL.md 内容", "content", latest?.content_md ?? "", 12)}</div>
        </div>`, async (data) => {
        const saved = await api(`/admin/api/skills/${idSeg(id)}`, { method: "PATCH", headers: revisionHeaders(skill), body: { name: data.get("name"), description: data.get("description") } });
        skill.revision = saved.revision;
        await api(`/admin/api/skills/${idSeg(id)}/versions`, { method: "POST", headers: revisionHeaders(skill), body: { version: data.get("version"), content: data.get("content"), publish: true } });
        toast("Skill 已更新并发布新版本");
        await renderSkills();
      }, "保存并发布");
    } catch (error) {
      toast(errorText(error), "error");
    }
  },

  openProviderEdit(id) {
    const provider = state.providers.find((item) => item.id === id);
    if (!provider) return;
    openModal("编辑 Provider", `
      <div class="form-grid">
        ${field("名称", "name", provider.name)}
        ${field("Base URL", "baseUrl", provider.baseUrl)}
        <div class="full">${field("新 API Key（留空不改）", "apiKey", "", "password", 'data-credential-input autocomplete="new-password"')}</div>
        ${credentialReferenceField("API Key 凭据 ID", "secretId", provider.secretId)}
        ${credentialHeaderFields(provider)}
      </div>`, async (data) => {
      await api(`/admin/api/providers/${idSeg(id)}`, { method: "PATCH", headers: revisionHeaders(provider), body: { name: data.get("name"), baseUrl: data.get("baseUrl"), apiKey: data.get("apiKey") || undefined, ...credentialReferenceChange(data, "secretId", provider.secretId, "apiKey"), ...credentialHeadersChange(data, provider) } });
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
        await api(`/admin/api/models/${idSeg(id)}`, { method: "PATCH", headers: revisionHeaders(model), body: { displayName: data.get("displayName"), contextWindow: Number(data.get("contextWindow")), maxOutputTokens: Number(data.get("maxOutputTokens")) } });
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
        ${appScopeFields(app.scopes ?? [])}
        <div class="full">${field("Webhook URL", "webhookUrl", app.webhookUrl ?? "")}</div>
        <div class="full">${field("新 Webhook Secret（留空不改）", "webhookSecret", "", "password", 'data-credential-input autocomplete="new-password"')}</div>
        ${credentialReferenceField("Webhook 凭据 ID", "webhookSecretId", app.webhookSecretId)}
      </div>`, async (data) => {
      await api(`/admin/api/apps/${idSeg(id)}`, { method: "PATCH", headers: revisionHeaders(app), body: { name: data.get("name"), status: data.get("status"), scopes: String(data.get("scopes") ?? "").split(",").map((item) => item.trim()).filter(Boolean), webhookUrl: data.get("webhookUrl"), webhookSecret: data.get("webhookSecret") || undefined, ...credentialReferenceChange(data, "webhookSecretId", app.webhookSecretId, "webhookSecret") } });
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
        ${scheduleFields(schedule.cron, schedule.timezone)}
        <div class="full">${recordFields("任务输入", "input", schedule.input_json ?? {})}</div>
      </div>`, async (data) => {
      await api(`/admin/api/schedules/${idSeg(id)}`, { method: "PATCH", headers: revisionHeaders(schedule), body: { name: data.get("name"), cron: data.get("cron"), timezone: data.get("timezone"), input: parseJsonField(data, "input", {}) } });
      toast("定时任务已更新");
      await renderSchedules();
    });
  },

  async openAgentRun(id) {
    try {
    const navigation = state.navigation;
    const detail = await api(`/admin/api/agents/${idSeg(id)}`);
    if (navigation !== state.navigation) return;
    const versions = detail.versions ?? [];
    if (!versions.length) { toast("没有可用版本，请先保存一个草稿", "error"); return; }
    const selected = versions.find(version => version.status === "draft") ?? versions.find(version => version.id === detail.publishedVersionId) ?? versions[0];
    const name = agentNameById(id);
    const errorId = "agent-run-text-error";
    openModal(`试运行 ${name}`, `${select("本次试运行版本", "versionId", versions.map(version => ({ value: version.id, label: `${vLabel(version.version)} · ${version.status === "draft" ? "草稿" : "已发布"}` })), selected.id)}<p class="hint">试运行仅使用选定版本，不会发布或切换线上版本。</p>${textarea("输入", "text", "你好，介绍一下 Forge。", 5, `aria-required="true" aria-describedby="${errorId}"`)}<p class="hint" id="${errorId}" role="alert" hidden></p>`, async (data) => {
      // P3：输入必填。空或只有空白时不发请求；有内容时 text 原样发送（不 trim）。
      const text = data.get("text");
      if (typeof text !== "string" || !text.trim()) {
        showFieldError("text", errorId, "请输入内容");
        return false;
      }
      const versionId = data.get("versionId");
      if (!versions.some(version => version.id === versionId)) throw new Error("请选择有效的试运行版本");
      const result = await api(`/admin/api/agents/${idSeg(id)}/run`, { method: "POST", body: { versionId, input: { text } } });
      toast(`Run 已创建：${result.runId}`);
      if (canPermission("run.view")) {
        await switchTab("runs");
        const navigation = state.navigation;
        setTimeout(() => { if (navigation === state.navigation) app.openRun(result.runId, navigation); }, 0);
      }
    }, "运行");
    } catch (error) { toast(errorText(error), "error"); }
  },

  async publishAgent(id) {
    try {
      const detail = await api(`/admin/api/agents/${idSeg(id)}`);
      const draft = (detail.versions ?? []).find((version) => version.status === "draft");
      if (!draft) {
        toast("没有待发布的草稿，请先创建新版本", "error");
        return;
      }
      const next = vLabel(draft.version);
      const current = detail.publishedVersion ? `当前线上版本是 ${vLabel(detail.publishedVersion)}` : "这个 Agent 目前还没有线上版本";
      if (!(await confirmAction(`发布「${detail.name}」${next}`, `发布后开放 API 和定时任务会立即改用 ${next}，${current}。`, "确认发布", false))) return;
      await api(`/admin/api/agents/${idSeg(id)}/publish`, { method: "POST", headers: revisionHeaders(detail), body: { versionId: draft.id } });
      toast(`已发布 ${next}`);
      await renderAgents();
    } catch (error) {
      toast(errorText(error), "error");
    }
  },

  async toggleAgentApi(id, enabled) {
    try {
      const agent = state.agents.find((item) => item.id === id);
      if (!enabled && !(await confirmAction(`关闭「${agent?.name ?? id}」的开放 API`, "关闭后外部应用无法再发起新调用；已在运行的任务会继续完成，结果仍可查询。之后可以随时重新开放。", "确认关闭"))) return;
      await api(`/admin/api/agents/${idSeg(id)}`, { method: "PATCH", headers: revisionHeaders(agent), body: { apiEnabled: enabled } });
      toast(enabled ? "已开放 API" : "已关闭 API");
      await renderAgents();
    } catch (error) {
      toast(errorText(error), "error");
    }
  },

  async openAgentDetail(id, navigation = state.navigation) {
    try {
      const agent = await api(`/admin/api/agents/${idSeg(id)}`);
      if (navigation !== state.navigation) return;
      const latest = agent.versions?.find(version => version.status === "draft") ?? agent.versions?.[0];
      const spec = latest?.spec_json ?? {};
      const readable = agentReadableConfig(spec);
      const summary = [["名称 / Key", `${agent.name} / ${agent.key}`], ["当前配置", latest ? `${vLabel(latest.version)} · ${latest.status === "draft" ? "草稿" : "已发布"}` : "暂无版本"], ["线上版本", agent.publishedVersion ?? "未发布"], ["开放 API", agent.apiEnabled ? "已开放" : "未开放"], ["模型", readable.model], ["指令", latest?.instructions ?? "—"], ["Skills", readable.skills], ["工具", readable.tools], ["预算", readable.budget]];
      openModal(`Agent · ${agent.name}`, `<dl class="config-summary">${summary.map(([label,value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("")}</dl>
        <div class="actions">${canPermission("agent.publish") ? `<button type="button" class="btn ghost" id="agent-detail-version">新版本草稿</button>` : ""}${canPermission("agent.run") ? `<button type="button" class="btn primary" id="agent-detail-run">选择版本试运行</button>` : ""}${canPermission("agent.publish") && agent.versions?.some(version => version.status === "draft") ? `<button type="button" class="btn ghost" id="agent-detail-publish">发布草稿</button>` : ""}</div>
        <details class="advanced-config"><summary>高级：原始配置与版本记录</summary><pre class="code-block">${json(agent)}</pre></details>`, async () => {}, "关闭");
      const actions = { "agent-detail-version": () => app.openAgentNewVersion(id), "agent-detail-run": () => app.openAgentRun(id), "agent-detail-publish": () => app.publishAgent(id) };
      for (const [name, action] of Object.entries(actions)) { const button = $(`#${name}`); if (button) button.onclick = action; }
    } catch (error) {
      if (navigation === state.navigation) toast(errorText(error), "error");
    }
  },

  openProviderCreate() {
    openModal("添加模型 Provider", `
      <div class="form-grid">
        ${field("Key", "key", "acme-llm")}
        ${field("名称", "name", "Acme 内网模型")}
        ${select("协议", "protocol", [{ value: "openai-compatible", label: "OpenAI-compatible" }, { value: "mock", label: "Mock (离线)" }], "openai-compatible")}
        ${field("Base URL", "baseUrl", "https://api.openai.com/v1")}
        <div class="full">${field("API Key", "apiKey", "", "password", 'data-credential-input autocomplete="new-password"')}</div>
        ${credentialReferenceField("API Key 凭据 ID", "secretId")}
        ${credentialHeaderFields()}
      </div>`, async (data) => {
      await api("/admin/api/providers", {
        method: "POST",
        body: {
          key: data.get("key"),
          name: data.get("name"),
          protocol: data.get("protocol"),
          baseUrl: data.get("baseUrl"),
          apiKey: data.get("apiKey"),
          ...credentialReferenceChange(data, "secretId", null, "apiKey"),
          ...credentialHeadersChange(data),
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
      await api(`/admin/api/providers/${idSeg(providerId)}/models`, {
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
      const result = await api(`/admin/api/providers/${idSeg(id)}/test`, { method: "POST", body: {} });
      toast(result.ok ? `连接成功：${result.content}` : `失败：${result.error}`, result.ok ? "ok" : "error");
    } catch (error) {
      toast(errorText(error), "error");
    }
  },

  openMcpCreate() {
    openModal("添加 MCP 服务", `
      <div class="form-grid">
        ${field("Key", "key", "docs-mcp")}
        ${field("名称", "name", "文档解析 MCP")}
        <div class="full">${field("HTTP URL", "url", "http://localhost:8090/mcp")}</div>
        ${credentialHeaderFields()}
      </div>`, async (data) => {
      const result = await api("/admin/api/mcp", { method: "POST", body: { key: data.get("key"), name: data.get("name"), url: data.get("url"), ...credentialHeadersChange(data) } });
      toast(result.warning ? `MCP 已保存，但工具发现失败：${result.warning}` : "MCP 已添加并发现工具", result.warning ? "error" : "ok");
      await renderMcp();
    });
  },

  async refreshMcp(id) {
    try {
      const server = state.mcp.find((item) => item.id === id);
      const result = await api(`/admin/api/mcp/${idSeg(id)}/refresh`, { method: "POST", headers: revisionHeaders(server), body: {} });
      toast(`已刷新 ${result.tools?.length ?? 0} 个工具`);
      await renderMcp();
    } catch (error) {
      toast(errorText(error), "error");
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
        ${credentialHeaderFields()}
        ${configurationImportField("OpenAPI 文件", "spec")}
      </div>`, async (data) => {
      if(!String(data.get("spec")??"").trim())throw new Error("请先选择 OpenAPI 文件或在高级配置中粘贴文档");
      await api("/admin/api/tool-sources/import", { method: "POST", body: { key: data.get("key"), name: data.get("name"), baseUrl: data.get("baseUrl"), ...credentialHeadersChange(data), spec: parseJsonField(data, "spec") } });
      toast("工具源已导入");
      await renderTools();
    }, "导入");
  },

  async installPackage() {
    try {
      const file = $("#package-file").files?.[0];
      const raw = file ? await configurationFileText(file) : $("#package-json").value;
      if(!raw.trim())throw new Error("请先选择能力包文件");
      const pack = JSON.parse(raw);
      const result = await api("/admin/api/plugins/install", { method: "POST", body: pack });
      toast(`安装完成：${Object.values(result.created ?? {}).flat().length} 个资源`);
      await renderPackages();
    } catch (error) {
      toast(errorText(error), "error");
    }
  },

  async uninstallPackage(id) {
    try {
      const plugin = state.plugins.find((item) => item.id === id);
      if (!(await confirmAction(`卸载能力包「${plugin?.name ?? plugin?.key ?? id}」`, "卸载只标记包状态，不会删除已经创建的 Agent、Skill、MCP 等资源。", "确认卸载"))) return;
      await api(`/admin/api/plugins/${idSeg(id)}/uninstall`, { method: "POST", headers: revisionHeaders(plugin), body: {} });
      toast("已标记卸载");
      await renderPackages();
    } catch (error) {
      toast(errorText(error), "error");
    }
  },

  async openRun(id, navigation = state.navigation) {
    closeStream();
    try {
      const run = await api(`/admin/api/runs/${idSeg(id)}`);
      if (navigation !== state.navigation) return;
      openModal(`Run ${run.id}`, `
        <div id="run-toolbar" class="toolbar">${runToolbarHtml(run)}</div>
        <div id="run-stream" class="muted"></div>
        <div class="run-detail">
          <dl class="config-summary"><dt>固定版本 ID</dt><dd>${esc(run.agentVersionId ?? "—")}</dd><dt>原始请求</dt><dd>${esc(run.input?.text ?? JSON.stringify(run.input ?? {}))}</dd></dl>
          <div><h4>消息</h4><div id="run-messages">${runMessagesHtml(run.messages)}</div></div>
          <details class="run-diagnostics"><summary>工具调用与实时事件</summary><h4>工具调用</h4><div id="run-tools">${runToolsHtml(run.toolCalls)}</div><h4>实时事件</h4><div id="event-log" class="event-log"></div></details>
        </div>`, async () => {}, "关闭");
      // 弹窗关闭（关闭按钮 / Esc / 取消 Run）一律关流；同一个函数引用重复 addEventListener 不会叠加。
      $("#modal").addEventListener("close", closeStream);
      listenRun(run.id, run.status);
      if (!RUN_ACTIVE_STATUSES.includes(run.status) && state.tab === "runs") await renderRuns();
    } catch (error) {
      toast(errorText(error), "error");
    }
  },

  // cancel 约定：2xx（各入口沿用 200）= 已接受取消请求，Run 在当前这次工具调用结束后才停下，所以此刻 Run 多半仍是 running。
  // Run 弹窗开着且是这条 Run：不关弹窗，按 REST 刷新弹窗里的 Run，SSE 继续等 run.cancelled；同时刷新列表。
  async cancelRun(id) {
    try {
      await api(`/admin/api/runs/${idSeg(id)}/cancel`, { method: "POST", body: {} });
      toast("已请求取消，当前步骤结束后停止");
      const view = state.runView;
      if (view && view.runId === id) await syncRunFromRest(view);
      await renderRuns();
    } catch (error) {
      toast(errorText(error), "error");
    }
  },

  async decideApproval(id, decision) {
    const approval = (state.approvals ?? []).find((item) => item.id === id);
    const hint = decision === "approved" && approvalReason(approval) === "interrupted" ? `<p class="muted">这次调用${esc(INTERRUPTED_BADGE_TEXT)}，批准会再执行一次。</p>` : "";
    const context = approval ? `<dl class="config-summary"><dt>Agent</dt><dd>${esc(approval.agent_name)}</dd><dt>工具</dt><dd>${esc(approval.tool_name ?? "未知工具")}</dd><dt>审批原因</dt><dd>${approvalReason(approval) === "interrupted" ? "执行中断，结果不确定，需要人工确认" : `按工具风险策略暂停（${esc(approval.risk_level)}）`}</dd><dt>到期时间</dt><dd>${esc(fmt(approval.expires_at))}</dd><dt>调用参数（已脱敏）</dt><dd>${esc(approval.args_preview || "无参数")}</dd></dl>${canPermission("run.view") ? `<a href="/#runs/${esc(encodeURIComponent(approval.run_id))}" target="_blank" rel="noopener noreferrer">在新标签页查看原始请求与执行记录</a>` : ""}<p class="hint">${decision === "approved" ? "批准后将继续执行工具调用" : "驳回后不执行本次工具调用"}，决定后不能撤回。</p>` : '<p class="hint">审批上下文已不可用，请刷新列表后重试。</p>';
    openModal(decision === "approved" ? "批准工具调用" : "驳回工具调用", `${context}${hint}${textarea("备注", "comment", "")}`, async (data) => {
      try {
        await api(`/admin/api/approvals/${idSeg(id)}/decide`, { method: "POST", body: { decision, comment: data.get("comment") } });
      } catch (error) {
        // R9：审批已失效（被接手替换 / 已处理 / 已过期 / Run 已结束）：专门提示，关确认框并刷新列表，不弹后端原文。
        if (error?.status !== 409 || !APPROVAL_STALE_CODES.has(error.code)) throw error;
        toast(`${error.code === "RUN-7005" ? APPROVAL_RUN_FINISHED_TEXT : APPROVAL_STALE_TEXT}（错误码 ${error.code}）`, "error");
        await renderApprovals();
        return;
      }
      toast(decision === "approved" ? "已批准，Run 将继续" : "已驳回");
      await renderApprovals();
    }, decision === "approved" ? "批准" : "确认驳回", decision !== "approved");
    // 记下当前开着的是哪条审批的确认框（approval.resolved expired 时据此关框）；确认框一关就清掉。
    state.approvalDialog = id;
    $("#modal").addEventListener("close", () => {
      if (state.approvalDialog === id) state.approvalDialog = null;
    }, { once: true });
  },

  openServiceAccountCreate() {
    openModal("新建服务账号", `
      <p class="muted">服务账号是定时任务的运行身份，不能登录。角色和数据范围决定任务能做什么、能看到哪些数据。</p>
      <div class="form-grid">
        ${field("名称", "name", "")}
        ${field("Key", "key", `svc-${Date.now()}`)}
        ${select("主角色", "role", (state.serviceRoleOptions ?? []).map(role => ({value:role.key,label:role.name})), "user")}
        ${select("数据范围", "dataScope", [{ value: "org", label: "org（本部门）" }])}
      </div>${additionalRolesField(state.serviceRoleOptions ?? [], [], "user")}`, async (data) => {
      await api("/admin/api/service-accounts", { method: "POST", body: { name: data.get("name"), key: data.get("key"), role: data.get("role"), additionalRoleIds:data.getAll("additionalRoleIds").filter(id => state.serviceRoleOptions?.find(role => role.id === id)?.key !== data.get("role")), dataScope: data.get("dataScope") } });
      toast("服务账号已创建");
      await renderSchedules();
    }, "创建");
    bindRoleFields();
  },

  openScheduleCreate() {
    if (!state.agents.length) {
      toast("请先创建并发布一个 Agent", "error");
      return;
    }
    const accounts = (state.serviceAccounts ?? []).filter((item) => item.status === "active");
    if (!state.serviceAccounts) {
      toast("新建定时任务需要选择服务账号，只有平台管理员能查看服务账号", "error");
      return;
    }
    if (!accounts.length) {
      toast("还没有可用的服务账号，请先点「新建服务账号」", "error");
      return;
    }
    openModal("新建定时任务", `
      <div class="form-grid">
        ${field("Key", "key", `schedule-${Date.now()}`)}
        ${field("名称", "name", "每日任务")}
        <div class="full">${select("Agent", "agentId", state.agents.map((agent) => ({ value: agent.id, label: `${agent.name} (${agent.key})` })))}</div>
        <div class="full">${select("运行身份（服务账号）", "serviceAccountId", accounts.map((item) => ({ value: item.id, label: `${item.name}（${item.role} · ${item.dataScope}）` })))}</div>
        ${scheduleFields()}
        <div class="full">${textarea("输入文本", "text", "执行今天的任务。", 4)}</div>
      </div>`, async (data) => {
      // P2：下拉没有可选值时 FormData 里是 null / 空串，先拦住给中文提示，不把 null 发给后端（否则是 400「agentId 必须是字符串」）。
      if (!data.get("agentId")) throw new Error("请选择 Agent；没有可选的 Agent 时请先创建并发布一个");
      if (!data.get("serviceAccountId")) throw new Error("请选择运行身份（服务账号）；没有可用的服务账号时请先新建");
      await api("/admin/api/schedules", { method: "POST", body: { key: data.get("key"), name: data.get("name"), agentId: data.get("agentId"), serviceAccountId: data.get("serviceAccountId"), cron: data.get("cron"), timezone: data.get("timezone"), input: { text: data.get("text") }, enabled: true } });
      toast("定时任务已创建");
      await renderSchedules();
    }, "创建");
  },

  async scheduleAction(id, action) {
    try {
      if (action === "run") {
        const result = await api(`/admin/api/schedules/${idSeg(id)}/run`, { method: "POST", body: {} });
        toast(`Run 已创建：${result.runId}`);
        if (canPermission("run.view")) await switchTab("runs");
        return;
      }
      const schedule = state.schedules.find((item) => item.id === id);
      if (action === "disable") {
        const nextRun = schedule?.next_run_at ? `，下次计划的 ${fmt(schedule.next_run_at)} 会取消` : "";
        const message = `停用后不会再按 ${schedule ? scheduleReadableTime(schedule.cron) : "执行计划"}（${schedule?.timezone ?? "默认时区"}）自动运行${nextRun}。之后可以随时重新启用。`;
        if (!(await confirmAction(`停用定时任务「${schedule?.name ?? id}」`, message, "确认停用"))) return;
      }
      await api(action === "enable" ? `/admin/api/schedules/${idSeg(id)}/enable` : `/admin/api/schedules/${idSeg(id)}/disable`, { method: "POST", headers: revisionHeaders(schedule), body: {} });
      toast(action === "enable" ? "已启用" : "已停用");
      await renderSchedules();
    } catch (error) {
      toast(errorText(error), "error");
    }
  },

  openAppCreate() {
    openModal("创建开放平台应用", `
      <div class="form-grid">
        ${field("Key", "key", "partner-app")}
        ${field("名称", "name", "合作方应用")}
        <div class="full">${field("Webhook URL", "webhookUrl", "")}</div>
        <div class="full">${field("Webhook Secret", "webhookSecret", "", "password", 'data-credential-input autocomplete="new-password"')}</div>
        ${credentialReferenceField("Webhook 凭据 ID", "webhookSecretId")}
        ${appScopeFields(["agents:read","runs:create","runs:read","runs:cancel"])}
      </div>`, async (data) => {
      await api("/admin/api/apps", { method: "POST", body: { key: data.get("key"), name: data.get("name"), webhookUrl: data.get("webhookUrl"), webhookSecret: data.get("webhookSecret"), ...credentialReferenceChange(data, "webhookSecretId", null, "webhookSecret"), scopes: String(data.get("scopes") ?? "").split(",").map((item) => item.trim()).filter(Boolean) } });
      toast("应用已创建");
      await renderApps();
    }, "创建");
  },

  createAppKey(appId) {
    openModal("新建密钥", `<div class="form-grid">${field("名称", "name", "default", "text", 'maxlength="128" required')}${field("有效期（可不填）", "expiresAt", "", "datetime-local")}</div>`, async (data) => {
      const expiresAt = data.get("expiresAt");
      const result = await api(`/admin/api/apps/${idSeg(appId)}/keys`, { method: "POST", body: { name: data.get("name"), expiresAt: expiresAt ? new Date(String(expiresAt)).toISOString() : null } });
      showAppKey(result);
      return false;
    }, "创建");
  },

  async listAppKeys(appId) {
    try {
      const result = await api(`/admin/api/apps/${idSeg(appId)}/keys`);
      openModal("API Keys", `<div class="table-wrap"><table class="api-keys-table"><thead><tr><th>名称</th><th>Prefix</th><th>Scopes</th><th>状态</th><th>有效期</th><th>最后使用</th><th>操作</th></tr></thead><tbody>${(result.items ?? []).map((key) => {
        const expired = key.expires_at && new Date(key.expires_at).getTime() <= Date.now();
        return `<tr><td>${esc(key.name)}</td><td class="mono">${esc(key.prefix)}</td><td class="mono">${esc(keyScopesText(key))}</td><td>${statusPill(key.status === "active" && expired ? "expired" : key.status)}</td><td>${key.expires_at ? fmt(key.expires_at) : "永久"}</td><td>${fmt(key.last_used_at)}</td><td><div class="actions">${result.canManage && key.status === "active" ? `${!expired ? `<button type="button" class="btn ghost small" onclick="app.rotateAppKey('${esc(key.id)}')">轮换</button>` : ""}<button type="button" class="btn danger small" onclick="app.revokeAppKey('${esc(key.id)}')">吊销</button>` : ""}</div></td></tr>`;
      }).join("")}</tbody></table></div>`, async () => {}, "关闭");
    } catch (error) {
      toast(errorText(error), "error");
    }
  },

  rotateAppKey(keyId) {
    const idempotencyKey = crypto.randomUUID();
    openModal("轮换密钥", field("旧密钥重叠时间（秒）", "overlapSeconds", "0", "number", 'min="0" max="86400" step="1" required'), async (data) => {
      const result = await api(`/admin/api/api-keys/${idSeg(keyId)}/rotate`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: { overlapSeconds: Number(data.get("overlapSeconds")) } });
      showAppKey(result);
      return false;
    }, "轮换");
  },

  revokeAppKey(keyId) {
    openModal("吊销密钥", "<p>吊销后，此密钥将立即失效。</p>", async () => {
      const result = await api(`/admin/api/api-keys/${idSeg(keyId)}/revoke`, { method: "POST" });
      toast("密钥已吊销");
      await this.listAppKeys(result.appId);
      return false;
    }, "吊销", true);
  },

  async openUser(id) {
    const current = id ? await api(`/admin/api/users/${idSeg(id)}`) : null;
    const orgs = await api("/admin/api/org-units").catch(error => { if (error.status === 403) return { items: [] }; throw error; });
    const roles = state.grantableRoles ?? [];
    const options = [...(state.roleOptions ?? []), ...(current?.roles ?? [])];
    const roleChoices = [...new Set([...roles, ...(current ? [current.role] : [])])];
    const additionalOptions = [...new Map(options.map(role => [role.id, role])).values()];
    const orgChoices = orgs.items.filter(org => org.status === "active").map(org => ({ value: org.id, label: org.name }));
    if (state.session.user.role === "platform_admin") orgChoices.unshift({ value: "", label: "未分配" });
    const fallbackOrg = current ? current.org_unit_id : state.session.user.orgUnitId;
    if (fallbackOrg && !orgChoices.some(org => org.value === fallbackOrg)) orgChoices.push({ value: fallbackOrg, label: fallbackOrg });
    openModal(current ? "编辑账号" : "新增账号", `<div class="form-grid">${field("登录名", "username", current?.username ?? "", "text", 'required maxlength="64" autocomplete="off"')}${field("邮箱", "email", current?.email ?? "", "email", 'required maxlength="255" autocomplete="off"')}${field("显示名", "displayName", current?.display_name ?? "", "text", 'required maxlength="128"')}${select("主角色", "role", roleChoices.map(role => ({value:role,label:options.find(item => item.key === role)?.name ?? ROLE_LABELS[role] ?? role})), current?.role ?? "user")}${select("数据范围", "dataScope", Object.entries(SCOPE_LABELS).map(([value,label]) => ({value,label})), current?.data_scope ?? "self")}${select("部门", "orgUnitId", orgChoices, current ? (current.org_unit_id ?? "") : (state.session.user.orgUnitId ?? ""))}${select("状态", "status", [{value:"active",label:"启用"},{value:"disabled",label:"停用"}], current?.status ?? "active")}${!current ? field("本地密码", "password", "", "password", 'data-credential-input minlength="8" maxlength="256" autocomplete="new-password"') : ""}</div>${additionalRolesField(additionalOptions, current?.additional_role_ids ?? [], current?.role ?? "user")}`, async data => {
      const body = Object.fromEntries(["username","email","displayName","role","dataScope","status"].map(key => [key, data.get(key)]));
      body.orgUnitId = data.get("orgUnitId") || null;
      body.additionalRoleIds = data.getAll("additionalRoleIds").filter(id => options.find(role => role.id === id)?.key !== body.role);
      if (!current && data.get("password")) body.password = data.get("password");
      await api(current ? `/admin/api/users/${idSeg(id)}` : "/admin/api/users", { method: current ? "PATCH" : "POST", headers: current ? revisionHeaders(current) : {}, body });
      toast(current ? "账号已更新" : "账号已创建");
      if (current?.id === state.session.user.id) {
        const session = await api("/auth/session", { auth: "probe" }).catch(error => { if (error.status === 401) return null; throw error; });
        if (!session) return;
        state.session = session;
        location.hash = routeAfterLogin(location.hash.slice(1));
        await enterApp();
      } else await renderUsers();
    }, "保存");
    bindRoleFields();
  },

  async userAction(id, action) {
    if (action === "edit") return this.openUser(id);
    const current = await api(`/admin/api/users/${idSeg(id)}`);
    if (action === "detail") {
      openModal(`账号 · ${current.username}`, `<dl><dt>显示名</dt><dd>${esc(current.display_name)}</dd><dt>邮箱</dt><dd>${esc(current.email)}</dd><dt>角色</dt><dd>${esc((current.roles ?? []).find(role => role.key === current.role)?.name ?? ROLE_LABELS[current.role] ?? current.role)}</dd><dt>附加角色</dt><dd>${esc((current.roles ?? []).filter(role => role.key !== current.role).map(role => `${role.name}${role.status === "active" ? "" : "（停用）"}`).join("、") || "无")}</dd><dt>有效功能权限</dt><dd>${esc((current.effective_permissions ?? []).map(permissionName).join("、") || "无")}</dd><dt>数据范围</dt><dd>${esc(SCOPE_LABELS[current.data_scope] ?? current.data_scope)}</dd><dt>本地密码</dt><dd>${current.has_local_password ? "已设置" : "未设置"}</dd><dt>创建时间</dt><dd>${esc(fmt(current.created_at))}</dd></dl>${canPermission("audit.view") ? '<div class="actions"><button type="button" class="btn ghost" id="user-target-audit">查看该账号变更</button><button type="button" class="btn ghost" id="user-actor-audit">查看该账号操作</button></div>' : ""}`, async () => {}, "关闭");
      for (const [buttonId, actor] of [["user-target-audit", false], ["user-actor-audit", true]]) {
        const button = $(`#${buttonId}`);
        if (button) button.onclick = () => { $("#modal").close(); Object.assign(state.auditFilters, { action: "", resourceType: actor ? "" : "user", resourceId: actor ? "" : id, actorId: actor ? id : "", outcome: "", from: "", to: "", cursor: "", history: [] }); app.switchTab("audit"); };
      }
      return;
    }
    if (action === "password") {
      openModal(`重置密码 · ${current.username}`, field("新密码", "password", "", "password", 'required data-credential-input minlength="8" maxlength="256" autocomplete="new-password"'), async data => {
        await api(`/admin/api/users/${idSeg(id)}/password`, { method: "POST", headers: revisionHeaders(current), body: { password: data.get("password") } });
        toast("密码已重置，原会话已撤销");
        if (id === state.session.user.id) showLogin(); else await renderUsers();
      }, "重置密码");
      return;
    }
    if (action === "binding") {
      const sso = await api("/admin/api/sso");
      openModal(`SSO绑定 · ${current.username}`, `${field("SSO subject", "subject", current.idp_subject ?? "", "text", 'maxlength="255"')}<div class="kv"><span>身份源</span><strong>${esc(sso.issuer ?? "未配置")}</strong></div>`, async data => {
        const subject = String(data.get("subject") ?? "");
        await api(`/admin/api/users/${idSeg(id)}/sso-binding`, { method: subject ? "PUT" : "DELETE", headers: revisionHeaders(current), ...(subject ? { body: { subject } } : {}) });
        toast(subject ? "SSO已绑定，原会话已撤销" : "SSO已解绑，原会话已撤销");
        if (id === state.session.user.id) showLogin(); else await renderUsers();
      }, "保存");
      return;
    }
    const deleting = action === "delete";
    const message = deleting ? `删除账号“${current.username}”？该账号的全部登录会话将立即失效。` : `撤销“${current.username}”的全部登录会话？`;
    openModal(deleting ? "删除账号" : "撤销会话", `<p>${esc(message)}</p>`, async () => {
      await api(`/admin/api/users/${idSeg(id)}${deleting ? "" : "/revoke-sessions"}`, { method: deleting ? "DELETE" : "POST", headers: revisionHeaders(current) });
      toast(deleting ? "账号已删除" : "会话已撤销");
      if (id === state.session.user.id) showLogin(); else await renderUsers();
    }, deleting ? "删除" : "撤销", true);
  },

  async openPasswordChange() {
    const session = await api("/auth/session");
    openModal("修改密码", `<p class="muted">修改后需要重新登录。</p><div class="form-grid">${field("当前密码", "currentPassword", "", "password", 'required data-credential-input maxlength="256" autocomplete="current-password"')}${field("新密码", "newPassword", "", "password", 'required data-credential-input minlength="8" maxlength="256" autocomplete="new-password" aria-describedby="password-rule"')}</div><p class="hint" id="password-rule">新密码为 8–256 个字符。</p>`, async data => {
      await api("/auth/password", { method: "POST", headers: revisionHeaders({ revision: session.user.revision }), body: { currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword") } });
      showLogin(); toast("密码已修改，请重新登录");
    }, "修改密码");
  },

  async openRole(id, copying = false) {
    try {
    const current = id ? await api(`/admin/api/roles/${idSeg(id)}`) : null;
    const catalog = state.permissionCatalog ?? (await api("/admin/api/roles")).catalog;
    openModal(copying ? "复制角色" : current ? "编辑角色" : "新增角色", `<div class="form-grid role-editor">${!current || copying ? field("角色代码", "key", "", "text", 'required maxlength="32" pattern="[a-z][a-z0-9_]{0,31}"') : `<div class="kv full"><span>角色代码</span><strong>${esc(current.key)}</strong></div>`}${field("角色名称", "name", copying ? `${current.name}副本` : current?.name ?? "", "text", 'required maxlength="128"')}${textarea("说明", "description", current?.description ?? "", 2, 'maxlength="1024"')}${!copying ? select("状态", "status", [{value:"active",label:"启用"},{value:"disabled",label:"停用"}], current?.status ?? "active") : ""}</div>${copying ? "" : permissionFields(catalog, current?.permissions ?? [])}`, async data => {
      const body = { name: data.get("name"), description: data.get("description") };
      if (!current || copying) body.key = data.get("key");
      if (!copying) Object.assign(body, { permissions: data.getAll("permissions"), status: data.get("status") });
      await api(current ? copying ? `/admin/api/roles/${idSeg(id)}/copy` : `/admin/api/roles/${idSeg(id)}` : "/admin/api/roles", { method: current && !copying ? "PATCH" : "POST", headers: current ? revisionHeaders(current) : {}, body });
      toast(copying ? "角色已复制" : "角色已保存");
      await afterRoleSave();
    }, copying ? "复制" : "保存");
    } catch (error) { toast(errorText(error), "error"); }
  },

  async roleAction(id, action) {
    if (action === "edit" || action === "copy") return this.openRole(id, action === "copy");
    const role = await api(`/admin/api/roles/${idSeg(id)}`);
    if (action === "preview") {
      const effective = role.status === "active" ? role.permissions : [];
      const allows = code => effective.includes("*") || effective.includes(code);
      const menus = navGroups.flatMap(group => group.items).filter(item => item.anyPermissions ? item.anyPermissions.some(allows) : !item.permission || allows(item.permission)).map(item => item.label);
      openModal(`权限预览 · ${role.name}`, `<dl><dt>状态</dt><dd>${role.status === "active" ? "启用" : "停用"}</dd><dt>可用菜单</dt><dd>${esc(menus.join("、") || "无")}</dd><dt>有效功能权限</dt><dd>${esc(effective.includes("*") ? "全部" : effective.map(permissionName).join("、") || "无")}</dd><dt>关联数量</dt><dd>${esc(Object.values(role.references ?? {}).reduce((sum,count) => sum + count, 0))}</dd></dl>`, async () => {}, "关闭");
      return;
    }
    const deleting = action === "delete";
    openModal(deleting ? "删除角色" : "恢复内置权限", `<p>${esc(deleting ? `删除角色“${role.name}”？` : `将“${role.name}”的功能权限恢复为内置模板？`)}</p>`, async () => {
      await api(deleting ? `/admin/api/roles/${idSeg(id)}` : `/admin/api/roles/${idSeg(id)}/reset`, { method: deleting ? "DELETE" : "POST", headers: revisionHeaders(role) });
      toast(deleting ? "角色已删除" : "内置权限已恢复");
      await afterRoleSave();
    }, deleting ? "删除" : "恢复", deleting);
  },

  openRoleMapping() {
    const mappings = [...(state.roleMappings ?? [])];
    openModal("添加 SSO 角色映射", `
      <div class="form-grid">
        ${field("Agent Role Code", "agentRoleCode", "admin")}
        ${field("Agent Role Name", "agentRoleName", "Administrator")}
        <div class="full">${select("Forge 角色", "localRole", (state.sso?.roleOptions ?? []).map(role => ({ value: role.key, label: role.name })))}</div>
      </div>`, async (data) => {
      const mapping = mappings.find((item) => item.agent_role_code === data.get("agentRoleCode"));
      await api("/admin/api/role-mappings", { method: "POST", headers: mapping ? revisionHeaders(mapping) : {}, body: { agentRoleCode: data.get("agentRoleCode"), agentRoleName: data.get("agentRoleName"), localRole: data.get("localRole") } });
      toast("映射已保存");
      await renderSso();
    });
  },
};

window.app = app;

const RUN_TERMINAL_EVENTS = ["run.completed", "run.failed", "run.cancelled", "run.budget_exhausted"];
const RUN_ACTIVE_STATUSES = ["queued", "running", "waiting_approval"];
const STREAM_MAX_RETRIES = 3;
// R9：升级前就已过期的审批，后端把 Run 直接标成 failed 并带这个码。换码只改这一行。
const RUN_APPROVAL_EXPIRED_CODE = "APR-2102";
const RUN_APPROVAL_EXPIRED_TEXT = "审批已过期，Run 已终止";

/** Run 失败原因（REST errorCode / errorMessage，或 SSE run.failed 的 data.error）：专门码用固定文案，其余用后端原文；都带错误码。 */
function runFailureText(code, message) {
  if (!code && !message) return "";
  const text = code === RUN_APPROVAL_EXPIRED_CODE ? RUN_APPROVAL_EXPIRED_TEXT : String(message || "Run 执行失败");
  return code ? `${text}（错误码 ${code}）` : text;
}

/**
 * SSE tool.interrupted 的可读记录；只用工具名、动作和次数，不显示参数和结果。
 * attempt = 被中断那次执行的序号（从 1 开始）：rerun 的重跑是第 attempt+1 次，confirm 写被中断的第 attempt 次。
 */
function toolInterruptedText(data) {
  const tool = String(data?.tool ?? "") || "未知工具";
  const attempt = Number.isInteger(data?.attempt) && data.attempt > 0 ? data.attempt : null;
  if (data?.action === "confirm") return attempt ? `工具 ${tool} 第 ${attempt} 次执行被中断，需重新确认` : `工具 ${tool} 执行被中断，需重新确认`;
  if (data?.action === "rerun") return `工具 ${tool} 执行中断，已自动重跑${attempt ? `（第 ${attempt + 1} 次）` : ""}`;
  return `工具 ${tool} 执行中断`;
}

/** 事件日志一行的正文（纯文本，调用方负责转义）：tool.interrupted 和带错误的 run.failed 显示可读文案，其余照旧显示 JSON。 */
function runEventText(type, data) {
  if (type === "tool.interrupted") return toolInterruptedText(data);
  if (type === "run.failed" && (data?.error?.code || data?.error?.message)) return `Run 失败：${runFailureText(data.error.code, data.error.message)}`;
  return JSON.stringify(data).slice(0, 320);
}

function runMessagesHtml(messages) {
  const rows = (messages ?? []).map((message) => `<div style="padding:10px 0;border-bottom:1px solid var(--border)" data-message-id="${esc(message.id)}"><div class="muted"><strong>${esc(message.role)}</strong> · #${esc(message.seq)}</div><div style="white-space:pre-wrap">${esc(message.content?.text ?? JSON.stringify(message.content))}</div></div>`).join("");
  return rows || `<span class="muted">暂无消息</span>`;
}

function runToolsHtml(toolCalls) {
  const rows = (toolCalls ?? []).map((call) => `<div style="padding:10px 0;border-bottom:1px solid var(--border)"><div><strong>${esc(call.tool_key)}</strong> ${statusPill(call.status)}</div><div class="muted mono">${esc(JSON.stringify(call.args))}</div><div style="white-space:pre-wrap">${esc(call.result_text ?? "")}</div></div>`).join("");
  return rows || `<span class="muted">暂无工具调用</span>`;
}

function runToolbarHtml(run) {
  const failure = RUN_ACTIVE_STATUSES.includes(run.status) || run.status === "succeeded" ? "" : runFailureText(run.errorCode, run.errorMessage);
  return `<span>${statusPill(run.status)}</span><span class="muted">成本 $${Number(run.costUsd).toFixed(4)}</span>${failure ? `<span class="muted">失败原因：${esc(failure)}</span>` : ""}${RUN_ACTIVE_STATUSES.includes(run.status) ? `${canPermission("run.cancel") ? `<button class="btn danger small" type="button" onclick="app.cancelRun('${esc(run.id)}')">取消 Run</button>` : ""}` : ""}`;
}

/** 以 REST 快照为准整体重渲染 Run 弹窗的状态栏、消息区和工具调用区（事件日志不动）。 */
function renderRunView(run) {
  const toolbar = $("#run-toolbar");
  const messages = $("#run-messages");
  const tools = $("#run-tools");
  if (toolbar) toolbar.innerHTML = runToolbarHtml(run);
  if (messages) messages.innerHTML = runMessagesHtml(run.messages);
  if (tools) tools.innerHTML = runToolsHtml(run.toolCalls);
}

/**
 * 「生成中…」只在连接正常且没收到 run.* 结束事件时显示；浏览器重连中显示重连进度；
 * 重连失败显示「连接已断开，点此刷新」（点击走 #run-stream 上的委托，不用内联处理器）。
 */
function renderStreamStatus(view) {
  const box = $("#run-stream");
  if (!box) return;
  if (view.finished) box.textContent = "";
  else if (view.link === "lost") box.innerHTML = `<button class="btn ghost small" type="button" data-run-refresh="1">连接已断开，点此刷新</button>`;
  else if (view.link === "retrying") box.textContent = `连接中断，正在重连（${view.attempts}/${STREAM_MAX_RETRIES}）…`;
  else box.textContent = "生成中…";
}

/**
 * SSE 新契约：不再有 message.delta；message.completed 只带 { text, usage }（没有消息 id / role），
 * 所以收到后重取 REST，按 REST 的 messages 整体重渲染，前端不拼内容、不去重。
 * 断线只靠 EventSource 自带的重连：浏览器重连时自动带 Last-Event-ID（服务端 streamRun 只认这个 header），
 * 最多 STREAM_MAX_RETRIES 次；重连成功后再用 REST 整体重渲染一次。
 */
function listenRun(runId, status) {
  closeStream();
  if (!$("#event-log")) return;
  const view = { runId, source: null, attempts: 0, link: "live", finished: !RUN_ACTIVE_STATUSES.includes(status), sync: 0 };
  state.runView = view;
  const box = $("#run-stream");
  if (box) {
    box.onclick = (event) => {
      if (event.target?.closest?.("[data-run-refresh]")) void refreshRunStream();
    };
  }
  connectRunStream(view);
  renderStreamStatus(view);
}

function connectRunStream(view) {
  const log = $("#event-log");
  if (!log) return;
  const runId = view.runId;
  const types = ["run.queued", "run.started", "run.resumed", "message.completed", "context.compressed", "model.retried", "output.rejected", "tool.started", "tool.retried", "tool.interrupted", "tool.completed", "tool.failed", "approval.required", "approval.resolved", ...RUN_TERMINAL_EVENTS];
  const source = new EventSource(`/admin/api/runs/${idSeg(runId)}/events`);
  view.source = source;
  state.eventSource = source;
  const current = () => state.runView === view && view.source === source;
  const append = (type, event) => {
    if (!current()) return;
    const row = document.createElement("div");
    row.className = "event-row";
    const payload = JSON.parse(event.data);
    row.innerHTML = `<span class="muted">${esc(payload.seq)}</span><span class="type">${esc(type)}</span><span>${esc(runEventText(type, payload.data))}</span>`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    if (RUN_TERMINAL_EVENTS.includes(type)) {
      view.finished = true;
      endRunStream(view);
      renderStreamStatus(view);
      void syncRunFromRest(view);
    } else if (type === "message.completed") {
      void syncRunFromRest(view);
    } else if (type === "approval.resolved") {
      onApprovalResolved(payload.data);
    }
  };
  for (const type of types) source.addEventListener(type, (event) => append(type, event));
  source.onopen = () => {
    if (!current()) return;
    const resumed = view.link !== "live";
    view.attempts = 0;
    view.link = "live";
    renderStreamStatus(view);
    if (resumed) void syncRunFromRest(view);
  };
  source.onerror = () => {
    if (!current()) return;
    if (view.finished) {
      endRunStream(view);
      return;
    }
    view.attempts += 1;
    if (source.readyState === EventSource.CLOSED || view.attempts > STREAM_MAX_RETRIES) {
      endRunStream(view);
      view.link = "lost";
    } else {
      view.link = "retrying";
    }
    renderStreamStatus(view);
    // 断线期间 Run 可能已结束（服务端在终态后会主动结束流）：以 REST 为准，结束了就不再提示断开。
    void syncRunFromRest(view);
  };
}

async function syncRunFromRest(view, { notify = false } = {}) {
  const ticket = ++view.sync;
  try {
    const run = await api(`/admin/api/runs/${idSeg(view.runId)}`);
    if (state.runView !== view || ticket !== view.sync) return;
    renderRunView(run);
    if (!RUN_ACTIVE_STATUSES.includes(run.status)) {
      view.finished = true;
      endRunStream(view);
    }
    renderStreamStatus(view);
    if (view.finished && state.tab === "runs") await renderRuns();
  } catch (error) {
    if (notify && state.runView === view) toast(errorText(error), "error");
  }
}

function endRunStream(view) {
  if (view.source) view.source.close();
  if (state.eventSource === view.source) state.eventSource = null;
  view.source = null;
}

/** 「连接已断开，点此刷新」：重取 REST；Run 仍在进行就清空事件日志、重新订阅（服务端从头回放，日志按原样重建）。 */
async function refreshRunStream() {
  const view = state.runView;
  if (!view) return;
  await syncRunFromRest(view, { notify: true });
  if (state.runView !== view || view.finished || view.link !== "lost") return;
  const log = $("#event-log");
  if (log) log.textContent = "";
  view.attempts = 0;
  view.link = "live";
  connectRunStream(view);
  renderStreamStatus(view);
}

function closeStream(event) {
  // 旧表单的 close 事件可能在同一 dialog 已复用为 Run 详情后才送达。
  if (event?.type === "close" && $("#modal")?.open) return;
  const view = state.runView;
  state.runView = null;
  if (view) endRunStream(view);
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

init();
