# Forge 接口清单（静态读取）

- 代码基准：worktree `/Users/libo/projects/forge-apisec`（detached `935f8f5`，在 `4b41289` 之上），路由基线 `tests/fixtures/routes-baseline.txt` 共 **86** 条。
- 生成方式：**全部静态读代码**（`apps/api/src/**`、`packages/{core,governance,identity,runtime,store,capabilities,models}/src/**`、`packages/store/src/schema.sql`），**没有发任何 HTTP 请求，没有起服务，没有建库**。
- 标注「静态推断」的条目是按代码路径推出来的结论，没有实际跑过，需要测试用例去验证。
- 生成时间：2026-10-22（Asia/Shanghai）。

## 0. 通用规则（所有接口共用，下文不再重复）

### 0.1 认证方式（三套，互不通用）

| 前缀 | 认证 | 代码 | 失败 |
|---|---|---|---|
| `/admin/api/*` | 会话 Cookie `forge_session` = `<token>.<HMAC-SHA256(token, SESSION_SECRET)>`；token 存在**进程内存** Map，8 小时过期 | `plugins/http-helpers.ts admin()`、`identity readSignedSessionCookie/getSession` | 无 Cookie / 签名错 / 不在内存 / 过期 → **401 AUTH-1001**「未登录或会话已过期」 |
| `/open/v1/*`（除 openapi.json） | `Authorization: Bearer fsk_...`（API Key，HMAC(pepper) 比对，前 16 位为前缀） | `routes/open.ts openApp()`、`identity authenticateApiKey` | 见第 8 节 |
| `/integration/v1/*` | `Authorization: Bearer <Connector Principal JWT>`，RS256，公钥来自 `AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64` | `routes/integration.ts connectorUser()`、`identity verifyConnectorPrincipal` | 见第 9 节 |

- 管理接口**只认 Cookie**，`Authorization: Bearer` 头在 admin 路由上完全不读（API Key 或 JWT 调管理接口 → 401 AUTH-1001，静态推断）。
- 会话里的 principal 是登录时的快照：用户之后被改角色、改 dataScope、停用，**已有会话不受影响**，直到 8h 过期或登出（`identity/index.ts createSession`，`PATCH /admin/api/users/:id` 不清会话）。

### 0.2 CSRF（`plugins/csrf.ts`）

- 根级 preHandler：URL 以 `/admin/api` 开头、方法不是 GET/HEAD/OPTIONS、**且带有效会话**时，要求 `X-CSRF-Token` 等于会话的 csrfToken，否则 **403 POL-2001**「CSRF Token 缺失或无效」。
- preHandler 在路由 handler 之前执行，所以对写接口：**CSRF 检查先于权限检查**（缺 CSRF 时有权限没权限都是 403）。没有会话时跳过 CSRF，由 handler 返回 401。
- `/auth/*`、`/open/*`、`/integration/*` 不做 CSRF。

### 0.3 权限与错误响应

- 权限检查：`admin(request, perm)` → `governance.assertPermission` → 角色缺权限 **403 POL-2001**「角色缺少权限: <perm>」。
- `ForgeError` → `{ error: { code, message, requestId, details, retryable } }`，HTTP 状态取 `httpStatus`（`plugins/errors.ts`）。
- **任何非 ForgeError 的异常**（MySQL 报错、cron-parser 抛错、fetch 网络错误、以及 Fastify 自身带 statusCode 的错误，如坏 JSON、超 bodyLimit、不支持的 Content-Type、空 JSON 体）一律被改成 **500 SYS-9001**「内部错误」，并 `request.log.error(error)` 打完整错误到日志（静态推断：`setErrorHandler` 对非 ForgeError 不看 `error.statusCode`）。
- 路由不存在：走 Fastify 默认 notFound，返回 Fastify 原生 404 格式（`{message, error, statusCode}`），不是 ForgeError 格式。
- `bodyLimit` = 2 MiB（`app.ts`），multipart 单文件 20 MiB（但没有路由消费 multipart）。
- 响应头 `X-Request-Id`：Fastify `requestIdHeader: "x-request-id"` 只是**读取**入站请求 ID，代码里没有把它写回响应头（静态推断）。

### 0.4 请求体解析约定（`http-helpers.ts`）

| 辅助函数 | 行为 |
|---|---|
| `bodyOf` | body 不是普通对象（数组、字符串、null）→ 当作 `{}` |
| `requireBodyString(k)` | 值必须是**字符串**且 trim 后非空，否则 **400 CFG-8501**「缺少字段: k」。数字、布尔等类型 → 同样 400 |
| `stringBody(k, fb)` | 不是字符串就**静默**用默认值 fb（类型传错不报错） |
| `arrayBody(k)` | 非数组 → `[]`；数组里非字符串元素被丢弃 |
| `jsonBody(k, fb)` | 字符串则 `JSON.parse`，失败静默用 fb；其他类型原样存 |
| `Number(body.x)` | 数值字段一律 `Number()`，**无范围/NaN 校验** |

- 未知字段：所有写接口都是 handler 白名单取字段 + repo 层 `allowed` 白名单，**未知字段不会写库**（静态确认：agents/apps/mcp/providers/models/schedules 的 update 都有 allowed 列表；users/service-accounts/skills 的 update 只拼固定列）。
- 字符串长度：代码层**没有长度校验**，上限只来自 MySQL 列宽（见各接口）。MySQL 8 默认 strict 模式下超长 → 报错 → **500 SYS-9001**（静态推断，取决于实例 sql_mode）。
- 唯一键冲突：只有部分接口先查重返回 409；没查重的接口撞唯一键 → MySQL ER_DUP_ENTRY → **500 SYS-9001**（静态推断，逐条标在下面）。

### 0.5 数据范围规则（`governance/index.ts`、各路由）

| 规则名 | 含义 | 用在 |
|---|---|---|
| **R-run** `runFilterFor/canAccessRun` | dataScope `all` 全部；`self` 只看 `subject_type=user AND subject_id=本人`；`org` 看本部门**子树**（AB `2244dbb` 后：`org_units.path = ? OR org_units.path LIKE ? ESCAPE '!'`，参数为转义 `!` `%` `_` 后的 path 并在末尾拼 `/`）；无部门 → 空；`app` 身份只看 `app_id=本应用` | runs、approvals、integration runs |
| **R-agent** `visibleAgentOrgIds/agentAccessible` | `all` 或 app → 全部；无部门 → 列表为空（`listAgents([])` 直接返回空），但详情类接口对 owner 为 NULL 的 agent 仍可访问（`agentAccessible`），列表与详情不一致；否则本部门子树 + owner 为 NULL 的。**`self` 和 `org` 一样按部门子树**，不区分 | agents、schedule 创建时的 agent |
| **R-sched** `scheduleVisible` | `all` 全部；否则 `schedule.org_unit_id === 本人 org_unit_id`（**精确等于，不含子部门**，与 R-run 不同） | schedules |
| **R-sa** `serviceAccountVisible` | `all` 全部；否则 `org_unit_id === 本人部门`（精确等于） | service-accounts、schedule 绑定服务账号 |
| **R-openapp** `appCanAccessAgent` | agent owner 为 NULL → 可见；app 无 owner 部门 → 不可见；否则 app 部门子树包含 agent owner | open/v1 agents |
| **无** | 不按部门过滤，有权限就看/改全部 | 见各接口「数据范围」列标「全局」 |

不可见资源统一返回 404（错误码都是 RUN-7001，只是 message 不同），和不存在一致——**仅限标了 R-xxx 的接口**；标「全局」的接口不存在跨部门 404。

---

## 1. 接口总表（86 条）

列说明：权限 = `admin()` 传入的权限 key；审计 = 成功后写 `audit_logs` 的 action（`—` = 不写）。失败/拒绝的请求**全部不写审计**（代码里只有成功路径调用 `writeAudit/repos.audit`）。
除特别说明，admin 写接口都可能返回：401 AUTH-1001、403 POL-2001（权限或 CSRF）、500 SYS-9001（非 ForgeError）。

### 1.1 公共 / 健康 / 控制台静态页（5 条 + 2 条控制台）

| # | 方法 路径 | 认证/权限 | 主要参数与校验 | 状态码 / 错误码 | 审计 | 代码 |
|---|---|---|---|---|---|---|
| 1 | GET `/` | 无 | — | 200 text/html（读 `apps/console/public/index.html`）；文件缺失 → 500 SYS-9001 | — | routes/console.ts |
| 2 | GET `/next` | 无 | — | 302 → `/next/` | — | routes/console.ts |
| 3 | GET `/next/*` | 无 | `*` 路径；`path.normalize` 后以 `..` 开头或绝对路径不当静态文件，回退 index.html | 200（静态文件，`assets/` 下 365d immutable；其余 no-cache SPA 回退）；未构建 → 503 text/plain | — | routes/console.ts |
| 4 | GET `/healthz` | 无 | — | 200 `{status:"ok",service,version}` | — | routes/health.ts |
| 5 | GET `/readyz` | 无 | — | 200 `{status:"ready",database:true}` / 503 `{status:"not_ready",database:false}` | — | routes/health.ts |

### 1.2 认证 `/auth/*`（6 条）

| # | 方法 路径 | 认证/权限 | 主要参数与校验 | 状态码 / 错误码 | 审计 | 代码 |
|---|---|---|---|---|---|---|
| 6 | GET `/auth/config` | 无 | — | 200 `{localLogin, oidcConfigured, ssoMode}` | — | routes/auth.ts |
| 7 | POST `/auth/local/login` | 无 | `email`、`password` 必填（requireBodyString，trim 非空字符串）；email 无格式校验 | 200 会话载荷 + Set-Cookie `forge_session`（HttpOnly，SameSite=Lax，`Secure` 仅 NODE_ENV=production，Path=/，Max-Age 8h）；400 CFG-8501 缺字段；403 POL-2001 本地登录已关闭（ALLOW_LOCAL_LOGIN=false）；401 AUTH-1001「邮箱或密码错误」（邮箱不存在、`status≠active`、无密码、密码错四种情况同码同文案）；**无限流/锁定**（代码里没有）；邮箱不存在时不跑 scrypt，存在时跑 scrypt → 响应时间可能不同（静态推断） | `auth.login.local`（actor_type user，resource user/本人）；失败不记 | routes/auth.ts、identity loginLocal |
| 8 | GET `/auth/session` | Cookie | — | 200 `{user, permissions, csrfToken, oidcConfigured, localLogin}`；401 AUTH-1001 | — | routes/auth.ts |
| 9 | POST `/auth/logout` | 可无 | — | 永远 200 `{ok:true}`；有会话则从内存删除 token 并清 Cookie；不做 CSRF（不在 /admin/api 下） | — | routes/auth.ts |
| 10 | GET `/auth/oidc/login` | 无 | query `returnTo`：字符串且以 `/` 开头才采用，否则 `/`（注意 `//host` 也以 `/` 开头） | 302 到 IdP；503 SSO-1201 未配置；502 SSO-1202 discovery 失败 | — | routes/auth.ts、identity buildOidcAuthorizeUrl |
| 11 | GET `/auth/oidc/callback` | 无 | query `code`、`state` 必填 | 302 到 returnTo；400 SSO-1203（缺参数 / state 不存在或过期）；401 SSO-1204/1205/1206/1207/1208/1209；403 SSO-1201（无映射角色）/SSO-1210（无邮箱）；500 SSO-1211；503 CON-4702（agent-principal 模式无公钥）；id_token 验签失败（jose 抛错）→ 500 SYS-9001（静态推断，未 catch） | `auth.login.oidc` | routes/auth.ts、identity handleOidcCallback |

### 1.3 Agent（8 条）

| # | 方法 路径 | 权限 | 数据范围 | 主要参数与校验 | 状态码 / 错误码 | 审计 action（details） | 代码 |
|---|---|---|---|---|---|---|---|
| 12 | GET `/admin/api/dashboard` | agent.view | **全局**（统计全库 runs/agents/approvals，不按部门） | — | 200 | — | admin/agents.ts |
| 13 | GET `/admin/api/agents` | agent.view | R-agent | 无 query 参数（无分页） | 200 `{items}`（含 draftVersion） | — | admin/agents.ts |
| 14 | POST `/admin/api/agents` | agent.manage | owner = 调用者部门 | `key` 必填，正则 `^[a-z0-9][a-z0-9-]{1,63}$`（2–64 位）；`name`（默认 key，≤128）、`description`（≤1024）、`instructions`（默认 "You are a helpful assistant."）、`spec`（对象或 JSON 字符串，坏 JSON 静默用默认）、`version`（默认 1.0.0，≤32）、`publish===true` 直接发布 | 200 `{id, versionId}`；400 CFG-8501（缺 key / 格式不符）；409 CFG-8503 key 已存在；并发同 key 两个请求都过了查重 → 唯一键冲突 500（静态推断） | `agent.create`（{key}） | admin/agents.ts |
| 15 | GET `/admin/api/agents/:id` | agent.view | R-agent → 不可见 404 | — | 200（含全部 versions 原始行）；404 RUN-7001「Agent 不存在」 | — | admin/agents.ts |
| 16 | PATCH `/admin/api/agents/:id` | agent.manage | R-agent | `name`、`description`、`status`（任意字符串，≤16，无枚举校验）、`apiEnabled`（真值→1）；其他字段忽略 | 200；404 RUN-7001 | `agent.update`（details = 实际改的字段） | admin/agents.ts |
| 17 | POST `/admin/api/agents/:id/versions` | **agent.publish** | R-agent | `version` 必填（≤32）；`instructions`、`spec`、`changelog`（≤2048）、`publish===true` | 200 `{versionId}`；400 CFG-8501 缺 version；404 RUN-7001；同 agent 重复 version → 唯一键 `uk_agent_versions` → 500（静态推断，无查重） | `agent.version.create`（{agentId}，resource agent_version） | admin/agents.ts |
| 18 | POST `/admin/api/agents/:id/publish` | agent.publish | R-agent | `versionId` 必填，须属于该 agent | 200；400 CFG-8501；404 RUN-7001「Agent 不存在」/「版本不存在」 | `agent.publish`（{agentId}，resource agent_version） | admin/agents.ts |
| 19 | POST `/admin/api/agents/:id/run` | agent.run | R-agent；Run 归属调用者（subject=user/本人，org=本人部门） | `versionId` 可选（**可指定任意版本，包括草稿**）；`input`（对象或 JSON 串，默认 `{text}`）、`text`、`threadId`（必须是同 agent、同主体的会话）；不检查 agent.status | 200 `{runId, threadId, status:"queued"}`；400 CFG-8501「Agent 没有可用版本」；404 RUN-7001「Agent 不存在」/「会话不存在」 | `run.create`（{agentId, versionId}） | admin/agents.ts、runtime createQueuedRun |

### 1.4 模型（6 条）

| # | 方法 路径 | 权限 | 数据范围 | 主要参数与校验 | 状态码 / 错误码 | 审计 | 代码 |
|---|---|---|---|---|---|---|---|
| 20 | GET `/admin/api/providers` | model.view | 全局 | — | 200（含 baseUrl，不含 apiKey） | — | admin/models.ts |
| 21 | POST `/admin/api/providers` | model.manage | 全局 | `key` 必填（≤64）、`baseUrl` 必填（≤2048，无 URL 格式校验）；`name`、`protocol`（默认 openai-compatible，≤32）、`apiKey`（AES-GCM 加密存）、`headers`、`timeoutMs`（Number，无范围校验） | 200 `{id}`；400 CFG-8501；409 CFG-8503 key 已存在；timeoutMs 非数字 → NaN 入库 → 500（静态推断） | `provider.create`（{key}） | admin/models.ts |
| 22 | POST `/admin/api/providers/:id/models` | model.manage | 全局 | `key` 必填（≤128）；`displayName`、`capabilities`、`contextWindow`/`maxOutputTokens`/`inputPrice`/`outputPrice`（Number，无校验） | 200 `{id}`；404 RUN-7001「Provider 不存在」；同 provider 重复 key → 唯一键 → 500（静态推断，无查重） | `model.create`（{providerId}） | admin/models.ts |
| 23 | PATCH `/admin/api/providers/:id` | model.manage | 全局 | `name`、`protocol`、`baseUrl`、`apiKey`（非空才更新）、`headers`、`timeoutMs`、`status`（任意字符串） | 200；404 RUN-7001 | `provider.update`（{name, status}） | admin/models.ts |
| 24 | PATCH `/admin/api/models/:id` | model.manage | 全局 | `displayName`、`capabilities`、数值 4 项、`status` | 200；404 RUN-7001「模型不存在」 | `model.update`（{displayName}） | admin/models.ts |
| 25 | POST `/admin/api/providers/:id/test` | model.manage | 全局 | 无 body；用该 provider 第一个模型发「请回复 pong」（**会对外发请求**） | 200 `{ok:true,...}` 或 200 `{ok:false,error}`（调用失败也是 200）；404 RUN-7001；400 CFG-8501「Provider 还没有模型」 | — | admin/models.ts |

### 1.5 MCP / Skill / 工具源（11 条）

| # | 方法 路径 | 权限 | 数据范围 | 主要参数与校验 | 状态码 / 错误码 | 审计 | 代码 |
|---|---|---|---|---|---|---|---|
| 26 | GET `/admin/api/mcp` | mcp.view | 全局 | — | 200（含 url、tools；不含 headers） | — | admin/capabilities.ts |
| 27 | POST `/admin/api/mcp` | mcp.manage | 全局 | `key` 必填（≤64）、`url` 必填（≤2048，**无协议/私网校验**，`discoverMcpTools` 不调用 `assertSafeUrl`）；`name`、`headers`、`transport`（默认 http，≤16）；创建后同步发现工具，失败写 `last_error` 并在 `warning` 返回 `String(error)` | 200 `{id, warning}`；400 CFG-8501；409 CFG-8503 | `mcp.create`（{key}） | admin/capabilities.ts、capabilities discoverMcpTools |
| 28 | PATCH `/admin/api/mcp/:id` | mcp.manage | 全局 | `name`、`url`、`headers`、`status` | 200；404 RUN-7001「MCP 不存在」 | `mcp.update`（details = 改动字段，**含 `headers_json` 原值，未打码**） | admin/capabilities.ts |
| 29 | POST `/admin/api/mcp/:id/refresh` | mcp.manage | 全局 | 无 body；向 url 发 MCP initialize/tools/list | 200 `{tools}`；404 RUN-7001；MCP 返回非 2xx / error / 格式无法解析 → 502 HTP-4001；连接失败、超时（fetch 抛 TypeError/AbortError）→ 500 SYS-9001（静态推断） | `mcp.refresh`（{tools: 数量}） | admin/capabilities.ts |
| 30 | GET `/admin/api/skills` | skill.view | 全局 | — | 200 `{items}`（未删除） | — | admin/capabilities.ts |
| 31 | POST `/admin/api/skills` | skill.manage | 全局 | `key` 必填（≤64，无格式校验）；`name`、`description`、`content`（默认 "# Skill\n"，MEDIUMTEXT）、`version`（默认 1.0.0）、`publish!==false` 即发布 | 200 `{id}`；400 CFG-8501；409 CFG-8503 | `skill.create`（{key}） | admin/capabilities.ts |
| 32 | GET `/admin/api/skills/:id` | skill.view | 全局 | — | 200（含 versions）；404 RUN-7001「Skill 不存在」 | — | admin/capabilities.ts |
| 33 | PATCH `/admin/api/skills/:id` | skill.manage | 全局 | `name`、`description`、`status` | 200；404 RUN-7001 | `skill.update`（{name}） | admin/capabilities.ts |
| 34 | POST `/admin/api/skills/:id/versions` | skill.manage | 全局 | `version` 必填；`content`；`publish!==false` | 200 `{versionId}`；400 CFG-8501；404 RUN-7001；重复 version → 唯一键 → 500（静态推断） | `skill.version.create`（{skillId}） | admin/capabilities.ts |
| 35 | GET `/admin/api/tool-sources` | tool.view | 全局 | — | 200（含 baseUrl、tools；不含 headers） | — | admin/capabilities.ts |
| 36 | POST `/admin/api/tool-sources/import` | tool.manage | 全局 | `key` 必填；`spec` 必须是对象或可解析的 JSON 字符串；`baseUrl` 或 `spec.servers[0].url` 二选一必有；`name`、`headers` | 200 `{id, tools}`；400 CFG-8501「spec 必须是 OpenAPI JSON」/「缺少 baseUrl 或 servers[0].url」；409 CFG-8503 | `tool_source.import`（{key, tools}） | admin/capabilities.ts |

### 1.6 运行与审批（6 条）

| # | 方法 路径 | 权限 | 数据范围 | 主要参数与校验 | 状态码 / 错误码 | 审计 | 代码 |
|---|---|---|---|---|---|---|---|
| 37 | GET `/admin/api/runs` | run.view | R-run | `status`（任意字符串，等值过滤）；`limit` = `Number(query.limit ?? 50)`，repo 夹到 [1,200]，但 **`Math.max(NaN,1)` 仍为 NaN**：`abc`、`1.5`→ 1.5 原样进 `LIMIT ?`；无分页 | 200 `{items}`；`limit=0/-1/1e9/101` → 夹到 1/1/200/101；`limit=abc` → `LIMIT NaN`、`limit=1.5` → `LIMIT 1.5` → MySQL 语法错误 → 500 SYS-9001；`limit=`（空串）→ Number("")=0 → 1 条（全部为静态推断） | — | admin/runs.ts、store runs.listRuns |
| 38 | GET `/admin/api/runs/:id` | run.view | R-run → 404 | — | 200（含 messages、**toolCalls 原始 `args`/`result`**、approvals）；404 RUN-7001「Run 不存在」（不存在和不可见同码同文案） | — | admin/runs.ts |
| 39 | GET `/admin/api/runs/:id/events` | run.view | R-run → 404 | 头 `Last-Event-ID`（非数字按 0） | 200 `text/event-stream`（hijack，500ms 轮询，Run 结束后关闭）；404 RUN-7001 | — | admin/runs.ts、http-helpers streamRun |
| 40 | POST `/admin/api/runs/:id/cancel` | run.cancel | R-run → 404 | 无 body | 200 `{ok:true}`（已结束的 Run 也返回 200，静默不处理）；404 RUN-7001 | `run.cancel`（已结束的 Run 也会记） | admin/runs.ts、runtime cancelRun |
| 41 | GET `/admin/api/approvals` | approval.view | R-run（SQL 过滤，total 一致） | `page`、`pageSize`：任一出现即分页；`undefined` 或空串 → 默认（page 1、pageSize 20）；必须 `Number.isInteger && ≥1`，否则 400；pageSize 上限 100（超过按 100，不报错）；`1e9` 是整数 → 合法 | 200 `{items}` 或 `{items,page,pageSize,total}`；400 CFG-8501「page 必须是正整数」/「pageSize 必须是正整数」（`0`、`-1`、`1.5`、`abc`） | — | admin/runs.ts、store listApprovalsVisible |
| 42 | POST `/admin/api/approvals/:id/decide` | approval.decide | 审批 → 关联 Run 走 R-run → 404 | `decision` ∈ {`approved`,`rejected`}；`comment`（≤1024） | 200 `{ok:true}`；400 CFG-8501「decision 必须为 approved/rejected」；404 RUN-7001「审批不存在」/「Run 不存在」（不可见时文案是「Run 不存在」，与不存在的「审批不存在」**文案不同**）；409 CFG-8503「审批已处理或已过期」（并发决定只有一个成功，`UPDATE ... WHERE status='pending'`） | `approval.decide`（{decision}） | admin/runs.ts |

### 1.7 定时任务（7 条）

所有 `:id` 路由经 `scheduleByIdRoute`：先 `admin(perm)`，再 `loadVisibleScheduleOr404`（R-sched）→ 不存在 / 不可见都是 **404 RUN-7001「定时任务不存在」**。

| # | 方法 路径 | 权限 | 数据范围 | 主要参数与校验 | 状态码 / 错误码 | 审计 | 代码 |
|---|---|---|---|---|---|---|---|
| 43 | GET `/admin/api/schedules` | schedule.view | R-sched（不含子部门） | — | 200 `{items}` | — | admin/schedules.ts |
| 44 | GET `/admin/api/schedules/:id` | schedule.view | R-sched → 404 | — | 200（与列表项同结构）；404 RUN-7001 | — | admin/schedules.ts |
| 45 | POST `/admin/api/schedules` | schedule.manage | schedule.org = 调用者部门 | 顺序：`agentId` 必填 → agent 走 R-agent；agent 未发布 → 400；`serviceAccountId` 必填 → R-sa；`cron` 必填 + `timezone`（默认 Asia/Shanghai）一起用 cron-parser 解析；`key`（默认 `schedule-<毫秒时间戳>`，≤64）、`name`、`input`、`enabled===true` 才是 active | 200 `{id}`；400 CFG-8501（缺字段 /「Agent 尚未发布」/「Cron 表达式无效」，坏时区也落在这里）；404 RUN-7001「Agent 不存在」/「服务账号不存在」；409 SCD-4801 服务账号已停用；400 SCD-4804 绑定 platform_admin 服务账号；重复 key → 唯一键 → 500（静态推断） | `schedule.create`（{agentId, serviceAccountId, cron}） | admin/schedules.ts |
| 46 | PATCH `/admin/api/schedules/:id` | schedule.manage | R-sched → 404 | `name`、`cron`、`timezone`、`input`、`status`（任意字符串）、`serviceAccountId`（走 R-sa + 状态/角色校验）。**只有同时传 `cron` 且 `status:"active"` 才解析 cron**，且不在 try 里 | 200；404 RUN-7001；404/409 SCD-4801/400 SCD-4804（服务账号）；`cron` 非法 + `status:"active"` → cron-parser 抛错 → 500 SYS-9001；`cron` 非法但不带 status → **直接存库**（静态推断） | `schedule.update`（details = 改动字段，含 `input_json` 原值） | admin/schedules.ts |
| 47 | POST `/admin/api/schedules/:id/enable` | schedule.manage | R-sched → 404 | 无 body | 200；409 SCD-4801（服务账号不存在或停用）；库里 cron/timezone 非法 → 500 SYS-9001 | **—（不写审计）** | admin/schedules.ts |
| 48 | POST `/admin/api/schedules/:id/disable` | schedule.manage | R-sched → 404 | 无 body | 200 | **—（不写审计）** | admin/schedules.ts |
| 49 | POST `/admin/api/schedules/:id/run` | schedule.run | R-sched → 404；Run 以服务账号（或旧版 service 身份）执行 | 无 body | 200 `{runId, trigger:"schedule"}`；400 CFG-8501「Agent 尚未发布」；409 SCD-4801；409 SCD-4802 并发策略 skip；409 SCD-4804（`buildScheduleIdentity` 抛的是 **409**，与绑定时的 400 不同） | `schedule.run`（{runId, runAs:{type,id}}） | admin/schedules.ts、runtime schedules.ts |

### 1.8 开放平台管理（7 条）

**这一组全部不按部门过滤**（apps 表有 `owner_org_unit_id`，但 handler 只查 id）。

| # | 方法 路径 | 权限 | 数据范围 | 主要参数与校验 | 状态码 / 错误码 | 审计 | 代码 |
|---|---|---|---|---|---|---|---|
| 50 | GET `/admin/api/apps/:id/webhook-deliveries` | apikey.view | 全局 | — | 200（最近 50 条）；404 RUN-7001「应用不存在」 | — | admin/apps.ts |
| 51 | POST `/admin/api/webhook-deliveries/:id/replay` | apikey.manage | 全局（不校验投递记录所属应用） | 无 body；重置为 pending 后**立即调用 `deliverDueWebhooks()` 对外投递** | 200 `{ok, status}`；404 RUN-7001「投递记录不存在」；409 CFG-8503「投递记录无法重放」（按 id 更新，记录存在时实际不会触发） | `webhook.replay`（{eventId}） | admin/apps.ts |
| 52 | GET `/admin/api/apps` | apikey.view | 全局 | — | 200（含 scopes、webhookUrl、限流配额；不含 secret） | — | admin/apps.ts |
| 53 | POST `/admin/api/apps` | apikey.manage | owner = 调用者部门 | `key` 必填（≤64，**无格式校验、无查重**）；`scopes` 字符串数组（**不校验取值**，空 → 默认 4 个）；`webhookUrl`（≤2048，无格式/私网校验）；`webhookSecret`（加密存）；`rateLimitPerMinute`/`dailyQuota`（Number，无范围校验，INT 列） | 200 `{id}`；400 CFG-8501；重复 key → 唯一键 → 500（静态推断） | `app.create`（{key}） | admin/apps.ts |
| 54 | PATCH `/admin/api/apps/:id` | apikey.manage | 全局 | `name`、`description`、`status`（任意字符串）、`scopes`、`webhookUrl`、`webhookSecret`（非空才更新）、两项数值 | 200；404 RUN-7001「应用不存在」 | `app.update`（{name, status}） | admin/apps.ts |
| 55 | GET `/admin/api/apps/:id/keys` | apikey.view | 全局 | — | 200 `{items}`（只有前缀等元数据，无 hash）；**应用不存在也返回 200 空数组**（不 404） | — | admin/apps.ts |
| 56 | POST `/admin/api/apps/:id/keys` | apikey.manage | 全局 | `name`（默认 default，≤128）；scopes 复制自应用；**无过期时间** | 200 `{id, key(明文一次), prefix, warning}`；404 RUN-7001 | `apikey.create`（{appId}） | admin/apps.ts |

### 1.9 用户、组织、SSO、审计（9 条）

| # | 方法 路径 | 权限 | 数据范围 | 主要参数与校验 | 状态码 / 错误码 | 审计 | 代码 |
|---|---|---|---|---|---|---|---|
| 57 | GET `/admin/api/users` | user.view | **全局**（org_admin 看到所有部门） | — | 200（`SELECT *` 去掉 password_hash；含 idp_subject、is_emergency_admin、status） | — | admin/identity.ts |
| 58 | POST `/admin/api/users` | user.manage | 新用户部门 = 调用者部门 | `email` 必填（≤255，无格式校验）；`role` ∈ 6 个内置角色（默认 user），否则 400；非 platform_admin 授予 platform_admin/org_admin → 403；`dataScope` **任意字符串**（≤16，默认按角色）；`username`（默认邮箱 @ 前，≤64）；`displayName`（≤128）；`password` 可选，**无长度/复杂度要求** | 200 `{id}`；400 CFG-8501（缺 email / 非法角色）；403 POL-2001「不能授予该角色」；409 CFG-8503「邮箱已存在」（只查 active 用户，见第 5 节）；username 重复 → 唯一键 → 500（静态推断） | `user.create`（{email, role}；不记密码） | admin/identity.ts |
| 59 | PATCH `/admin/api/users/:id` | user.manage | **全局**（不校验目标用户部门） | `role`（默认目标原角色）同上校验；`dataScope` 任意字符串，**不传时重置为角色默认值**；`status` 任意字符串（≤16） | 200；404 RUN-7001「用户不存在」；400 非法角色；403 不能授予该角色（目标是 platform_admin 且不传 role 时也 403） | `user.update`（{role, dataScope}；status 变化不记） | admin/identity.ts |
| 60 | GET `/admin/api/permissions` | role.view | — | — | 200 `{roles: ROLE_PERMISSIONS}` | — | admin/identity.ts |
| 61 | GET `/admin/api/org-units` | org.view | 全局 | — | 200 | — | admin/identity.ts |
| 62 | GET `/admin/api/role-mappings` | sso.manage | 全局 | — | 200 | — | admin/identity.ts |
| 63 | POST `/admin/api/role-mappings` | sso.manage | 全局 | `agentRoleCode` 必填（≤100）、`localRole` 必填（≤32，**不校验是否为合法角色**）、`agentRoleName`（≤100） | 200；400 CFG-8501 | `role_mapping.upsert`（details = **整个请求体**，resource_id 为 NULL） | admin/identity.ts |
| 64 | GET `/admin/api/audit` | audit.view | **全局** | `limit` = Number(默认 100)，只做 `Math.min(limit,500)`，**无下限/NaN 处理** | 200；`limit=0` → 空；`-1`、`1.5`、`abc` → `LIMIT -1/1.5/NaN` → 500 SYS-9001（静态推断）；`1e9`、`101` → 500 条 / 101 条 | — | admin/identity.ts、store audit.listAudit |
| 65 | GET `/admin/api/sso` | sso.manage | — | — | 200（模式、connector 开关、映射） | — | admin/identity.ts |

### 1.10 插件（3 条）

| # | 方法 路径 | 权限 | 数据范围 | 主要参数与校验 | 状态码 / 错误码 | 审计 | 代码 |
|---|---|---|---|---|---|---|---|
| 66 | GET `/admin/api/plugins` | package.view | 全局 | — | 200 | — | admin/plugins.ts |
| 67 | POST `/admin/api/plugins/install` | plugin.install | 资源 owner = 调用者部门 | `resources.agents[]/skills[]/mcp[]/providers[](.models[])`，每项 `key` 必填（mcp 另需 `url`，provider 另需 `baseUrl`，model 需 `key`）；已存在的 key 跳过；顶层 `key` 必填但**在创建完所有资源之后才检查**；`version`（默认 1.0.0）、`type`、`name`、`manifest`。agent 直接以 published 创建（不检查 agent.publish）；同 (key,version) 再装 → upsert | 200 `{id, created}`；400 CFG-8501（任一缺字段 → **之前已建的资源不回滚，也不写审计**）；model 重复 key → 500（静态推断） | `plugin.install`（details = 新建资源 id 列表） | admin/plugins.ts |
| 68 | POST `/admin/api/plugins/:id/uninstall` | plugin.uninstall | 全局 | 无 body | **永远 200**（id 不存在也 200，不 404）；只把 plugins.status 改为 uninstalled，资源保留 | `plugin.uninstall`（id 不存在也记） | admin/plugins.ts |

### 1.11 服务账号（4 条）

`service_account.manage` 只有 platform_admin 有（见第 3 节），所以下面的部门过滤逻辑对其他角色实际走不到。

| # | 方法 路径 | 权限 | 数据范围 | 主要参数与校验 | 状态码 / 错误码 | 审计 | 代码 |
|---|---|---|---|---|---|---|---|
| 69 | GET `/admin/api/service-accounts` | service_account.manage | R-sa | — | 200 | — | admin/service-accounts.ts |
| 70 | POST `/admin/api/service-accounts` | service_account.manage | 部门 = 调用者部门 | `name` 必填（≤128）；`key`（默认 `svc-<时间戳>`，≤64，查重）；`role` ∈ 内置角色（默认 user）；`dataScope` ∈ {org, all}（默认 org）；`description` | 200 `{id}`；400 CFG-8501（缺 name / 非法角色 / 数据范围非法）；400 SCD-4804 platform_admin；403 POL-2001（非 PA 授 org_admin / 非 all 授 all）；409 CFG-8503 key 已存在 | `service_account.create`（{key, role, dataScope}） | admin/service-accounts.ts |
| 71 | GET `/admin/api/service-accounts/:id` | service_account.manage | R-sa → 404 | — | 200；404 RUN-7001「服务账号不存在」 | — | admin/service-accounts.ts |
| 72 | PATCH `/admin/api/service-accounts/:id` | service_account.manage | R-sa → 404 | `name`（空串被忽略）、`description`、`role`/`dataScope`（任一传了就整体校验）、`status` ∈ {active, disabled} | 200；400 CFG-8501 / SCD-4804；403 POL-2001；404 RUN-7001 | `service_account.disable`（status=disabled 时）否则 `service_account.update`（{before, changes}） | admin/service-accounts.ts |

### 1.12 开放 API `/open/v1/*`（9 条）

`openApp(scope)` 顺序：缺 `Bearer ` → **401 AUTH-1001**「缺少 API Key」；不以 `fsk_` 开头 → 401「API Key 格式不正确」；前缀找不到 / 已吊销 / hash 不符 → 401「API Key 无效」；过期 → 401「API Key 已过期」；scope 不足 → **403 POL-2001**「应用缺少 Scope: x」；应用不存在或 `status≠active` → **401 AUTH-1001**「应用已停用」；每应用每分钟计数超 `rate_limit_per_minute` → **429 OPN-4502**（进程内存计数，重启清零）。scope 检查在应用停用检查之前。

| # | 方法 路径 | Scope | 数据范围 | 主要参数与校验 | 状态码 / 错误码 | 审计 | 代码 |
|---|---|---|---|---|---|---|---|
| 73 | GET `/open/v1/agents` | agents:read | R-openapp，且 `api_enabled` 且已发布 | — | 200 `{items}` | — | routes/open.ts |
| 74 | GET `/open/v1/agents/:key` | agents:read | 同上 → 404 | — | 200；404 RUN-7001「Agent 不存在」 | — | routes/open.ts |
| 75 | POST `/open/v1/agents/:key/runs` | runs:create | 同上；Run 的 org = 应用部门 | `input`/`text`、`threadId`（须同 agent 同主体，否则 404「会话不存在」）；头 `Idempotency-Key`（trim 后 ≤200） | 202 `{runId, threadId, status, agentKey}`；重放 200 + `Idempotency-Replayed: true`；400 CFG-8501「Idempotency-Key 过长」；404 RUN-7001；409 OPN-4503（同键不同请求 / 同键处理中）；429 OPN-4501 日配额 | `open.run.create`（actor_type app，{agentKey}） | routes/open.ts、runtime idempotency.ts |
| 76 | POST `/open/v1/agents/:key/invoke` | runs:create | 同上 | 同上 + query `wait`（秒，取整后夹到 [1,120]，非数字用 30） | 200（Run 已结束，含 output/usage/error）或 202；其余同 #75 | `open.run.create`（{agentKey, wait}） | routes/open.ts、runtime invoke.ts |
| 77 | GET `/open/v1/openapi.json` | 无认证 | — | — | 200（静态 OpenAPI 3.1 骨架） | — | routes/open.ts |
| 78 | GET `/open/v1/runs/:id` | runs:read | `run.app_id = 本应用` → 404 | — | 200；404 RUN-7001「Run 不存在」 | — | routes/open.ts |
| 79 | POST `/open/v1/runs/:id/cancel` | runs:cancel | 同上 | — | 200 `{ok, status:"cancelling"}`（已结束也 200）；404 RUN-7001 | **—** | routes/open.ts |
| 80 | GET `/open/v1/runs/:id/events` | runs:read | 同上 | 头 `Last-Event-ID` | 200 SSE；404 RUN-7001 | — | routes/open.ts |
| 81 | GET `/open/v1/runs/:id/result` | runs:read | 同上 | — | 200；404 RUN-7001；409 RUN-7002「Run 尚未结束」（details.status） | — | routes/open.ts |

### 1.13 集成 `/integration/v1/*`（5 条）

`connectorUser()` 顺序：缺 `Bearer ` → **401 AUTH-1001**「缺少 Connector Principal」；Connector 总开关或入站开关关 → **503 CON-4703**（当前开发 .env 两个开关都是 false，所以带 Bearer 的请求全部 503）；legacy fallback 开 → 503 CON-4704；无公钥 → 503 CON-4702；验签失败 / 过期 / issuer、audience 不符 / 格式错 → **401 CON-4707**（`jwtVerify` 传入 RS256 公钥，`alg:none` 和 HS256 会被 jose 拒绝，落到 CON-4707，静态推断）；缺 subject/principalType → 401 CON-4701；environment 不符 → 401 CON-4705；subject 在 users.idp_subject 找不到 → **403 CON-4706**（查询**不过滤 status**，停用用户仍能通过）。
**这一组没有任何权限 key 检查**（不检查 agent.run / run.view / run.cancel）。

| # | 方法 路径 | 权限 | 数据范围 | 主要参数与校验 | 状态码 / 错误码 | 审计 | 代码 |
|---|---|---|---|---|---|---|---|
| 82 | GET `/integration/v1/agents` | 无 | 按映射用户所在部门子树 + 无主 Agent 过滤（L 续篇 `b038bd2`）；停用的 Agent 不列出；**不检查 `api_enabled`**（该开关只管开放平台 App Key 入口） | — | 200 `{items}` | — | routes/integration.ts |
| 83 | POST `/integration/v1/runs` | 无 | 可见性同 #82；范围外 → 404 RUN-7001；停用 → 409 CFG-8503 | `agentKey` 必填；`input`/`text` | 202 `{runId, status}`；400 CFG-8501；404 RUN-7001「Agent 不存在」（不存在或未发布） | **—** | routes/integration.ts |
| 84 | GET `/integration/v1/runs/:id` | 无 | R-run（按映射用户的 dataScope）→ 404 | — | 200；404 RUN-7001 | — | routes/integration.ts |
| 85 | GET `/integration/v1/runs/:id/result` | 无 | R-run → 404 | — | 200；404 RUN-7001；409 RUN-7002 | — | routes/integration.ts |
| 86 | POST `/integration/v1/runs/:id/cancel` | 无 | R-run → 404 | — | 200 `{ok:true}`；404 RUN-7001 | **—** | routes/integration.ts |

### 1.14 计数核对

公共/健康/控制台 5（#1–5）+ auth 6 + agent 8 + 模型 6 + MCP/Skill/工具 11 + 运行审批 6 + 定时任务 7 + 开放平台管理 7 + 用户组织 SSO 审计 9 + 插件 3 + 服务账号 4 + open 9 + integration 5 = **86**，与 `routes-baseline.txt` 逐行一致。

### 1.15 审计汇总

- 写审计的 action（36 个）：`auth.login.local`、`auth.login.oidc`、`agent.create`、`agent.update`、`agent.version.create`、`agent.publish`、`run.create`、`provider.create`、`model.create`、`provider.update`、`model.update`、`mcp.create`、`mcp.update`、`mcp.refresh`、`skill.create`、`skill.update`、`skill.version.create`、`tool_source.import`、`run.cancel`、`approval.decide`、`schedule.create`、`schedule.update`、`schedule.run`、`webhook.replay`、`app.create`、`app.update`、`apikey.create`、`user.create`、`user.update`、`role_mapping.upsert`、`plugin.install`、`plugin.uninstall`、`service_account.create`、`service_account.update`/`service_account.disable`、`open.run.create`。
- **写操作但不写审计**：`POST /auth/logout`、`POST /admin/api/schedules/:id/enable`、`POST /admin/api/schedules/:id/disable`、`POST /open/v1/runs/:id/cancel`、`POST /integration/v1/runs`、`POST /integration/v1/runs/:id/cancel`；`POST /admin/api/providers/:id/test` 和 `POST /admin/api/mcp`（创建时的发现）会对外发请求但不单独记。
- 失败、被拒绝（401/403/404/400）的请求**都不记**；登录失败也不记。
- 审计表字段只有 actor_type、actor_id、action、resource_type、resource_id、details_json、created_at——**没有 IP、UA、traceId/requestId、前后值**（只有 service_account.update 记了 before）。
- details 里可能出现未打码的敏感值：`mcp.update` 记 `headers_json` 原值；`schedule.update` 记 `input_json` 原值；`role_mapping.upsert` 记整个请求体。`user.create` 不记密码，`provider.create/update` 不记 apiKey，`app.update` 不记 webhookSecret。

---

## 2. 错误码表

### 2.1 代码里实际抛出的错误码（37 个，可能出现在 HTTP 响应或 Run 结果里）

| 码 | HTTP | 含义（代码里的 message） | 代码出处 | 出现在哪些接口 |
|---|---|---|---|---|
| AUTH-1001 | 401 | 未登录或会话已过期 / 邮箱或密码错误 / 缺少 API Key / API Key 格式不正确 / API Key 无效 / API Key 已过期 / 应用已停用 / 缺少 Connector Principal | core/index.ts `errors.unauthorized`；identity loginLocal、authenticateApiKey；routes/open.ts、integration.ts | 全部 admin、auth/session、local/login、open、integration |
| POL-2001 | 403 | 没有权限执行该操作 / 角色缺少权限: x / 应用缺少 Scope: x / CSRF Token 缺失或无效 / 本地登录已关闭 / 不能授予该角色 / 不能授予超出自身的数据范围 | core `errors.forbidden`；governance assertPermission/assertScope；plugins/csrf.ts；identity loginLocal；admin/identity.ts、service-accounts.ts | 全部 admin、open、local/login |
| RUN-7001 | 404 | 资源不存在（各处 message：Agent/版本/Run/审批/定时任务/服务账号/应用/投递记录/Provider/模型/MCP/Skill/用户/会话 不存在） | core `errors.notFound`；各路由；runtime createQueuedRun；governance assertRunAccess | 所有带 id 的接口 |
| CFG-8501 | 400 | 参数校验失败 / 缺少字段: x / key 格式 / page、pageSize 必须是正整数 / decision 非法 / 非法角色 / Cron 表达式无效 / Agent 尚未发布 / Agent 没有可用版本 / Provider 还没有模型 / spec 非法 / 缺少 baseUrl / 数据范围非法 / 状态非法 / Idempotency-Key 过长 | core `errors.invalid`；runtime idempotency.ts | 多数写接口、approvals、open runs/invoke |
| CFG-8503 | 409 | 资源状态冲突 / key 已存在 / 邮箱已存在 / 审批已处理或已过期 / 投递记录无法重放 | core `errors.conflict` | 创建类、approvals decide、webhook replay |
| SYS-9001 | 500 | 内部错误（所有非 ForgeError）；运行时：消息序号分配失败、Run 未分类异常 | plugins/errors.ts；runtime messages.ts、loop.ts | 全部接口（兜底）；Run 的 error_code |
| SYS-9002 | 500 | Provider 凭据无法解密 | models/index.ts | Run 执行、providers/:id/test（被 catch 成 200 ok:false） |
| SSO-1201 | 503 / 403 | SSO 尚未配置（503）；当前账号没有 Forge 访问角色（403） | routes/auth.ts；identity | oidc/login、oidc/callback |
| SSO-1202 | 502 | 无法获取 OIDC discovery | identity discovery | oidc/login、callback |
| SSO-1203 | 400 | 回调参数缺失 / 登录状态已过期 | routes/auth.ts；identity | oidc/callback |
| SSO-1204 | 401 | OIDC 令牌交换失败 | identity | oidc/callback |
| SSO-1205 | 401 | OIDC 未返回 id_token | identity | oidc/callback |
| SSO-1206 | 401 | nonce 校验失败 | identity | oidc/callback |
| SSO-1207 | 401 | 未返回 access_token | identity | oidc/callback |
| SSO-1208 | 401 | access_token 与 id_token 主体不一致 | identity | oidc/callback |
| SSO-1209 | 401 | OIDC 主体缺失 | identity | oidc/callback |
| SSO-1210 | 403 | 用户缺少邮箱，无法创建本地账号 | identity | oidc/callback |
| SSO-1211 | 500 | 用户创建失败 | identity | oidc/callback |
| CON-4701 | 401 | Principal 缺少主体 | identity verifyConnectorPrincipal | integration/* |
| CON-4702 | 503 | Connector 验签公钥未配置 | identity connectorPublicKey | integration/*、oidc/callback |
| CON-4703 | 503 | Connector 入站未启用 | identity | integration/* |
| CON-4704 | 503 | Connector legacy fallback 必须关闭 | identity | integration/* |
| CON-4705 | 401 | 运行环境不匹配 | identity | integration/* |
| CON-4706 | 403 | Connector 主体未在 Forge 登记 | identity principalForConnector | integration/* |
| CON-4707 | 401 | Connector 令牌无效或已过期 | identity | integration/* |
| OPN-4501 | 429 | 应用今日配额已用完 | routes/open.ts | open runs、invoke |
| OPN-4502 | 429 | 请求频率超限（details {limit, window}，retryable） | routes/open.ts | 全部 open（除 openapi.json） |
| OPN-4503 | 409 | 相同 Idempotency-Key 不能用于不同请求 / 正在处理 | runtime idempotency.ts | open runs、invoke |
| RUN-7002 | 409 | Run 尚未结束 | routes/open.ts、integration.ts | open/integration result |
| SCD-4801 | 409 | 服务账号已停用（不能启用/运行定时任务） | admin/schedules.ts；runtime schedules.ts | schedules POST/PATCH/enable/run；调度器暂停 |
| SCD-4802 | 409 | 该定时任务已有运行中的 Run（并发策略 skip） | admin/schedules.ts | schedules/:id/run |
| SCD-4804 | 400 / 409 | 不能绑定 platform_admin 服务账号（400，绑定/创建服务账号时）；服务账号不能以 platform_admin 运行（409，`buildScheduleIdentity`） | admin/schedules.ts、service-accounts.ts；runtime schedules.ts | schedules、service-accounts |
| MDL-3001 | 502 | 模型调用失败 / 模型接口返回 xxx / Mock 上游 5xx | core `errors.model`；models | Run error_code；providers/:id/test（200 ok:false） |
| MDL-3003 | 502 | 模型没有返回流 / 模型返回不是合法 JSON | models | 同上 |
| MDL-3004 | 504 | 模型调用超时 | models | 同上 |
| HTP-4001 | 502 | 工具调用失败（errors.tool）：MCP 返回非 2xx/错误/格式无法解析、仅允许 HTTP/HTTPS、默认禁止访问私网地址 | core `errors.tool`；capabilities；runtime tools.ts | mcp/:id/refresh（HTTP 502）；工具调用结果码 |
| HTP-4002 | 502 | 工具重试次数已耗尽；工具结果码（408/429/5xx） | runtime tools.ts；capabilities | 只在 Run 内部 |

### 2.2 只出现在 Run / 工具结果里、不作为 HTTP 错误返回的码（6 个）

| 码 | 含义 | 出处 |
|---|---|---|
| BUD-5001 | 成本预算已耗尽（`errors.budget` 定义为 400，但实际只用作 Run error_code） | core；runtime loop.ts |
| RUN-7004 | 达到最大步数 | runtime loop.ts |
| OUT-6001 | 结构化输出不符合 Schema | runtime loop.ts |
| SCD-4803 | 定时任务触发时出现未分类异常 | runtime schedules.ts |
| MCP-4101 | MCP 工具返回 isError | capabilities |
| MCP-4102 | 可重试的 MCP 错误（在重试集合里，代码里没有地方产生它） | runtime tools.ts |

合计：2.1 的 37 个 + 2.2 的 6 个 = **43 个**（与 `grep` 代码中全部 `XXX(X)-NNNN` 字面量去重结果一致）。其中 HTP-4002、MDL-*、SYS-9002 主要出现在 Run 的 error_code，HTTP 层只在 #25（被 catch 成 200）/#29 等少数路径可见。

### 2.3 文档里有、代码里没有的码

`APR-2102`（审批超时）、`APR-2103`（并发决定）、`MDL-3002`（上下文超长）、`RUN-7003`（输入校验）、`OPN-4504`（413 超限）、`OPN-4505`（415 Content-Type）、`SYS-9003`（上游不可用）、`WHK-4601`（Webhook 验签）、`DOC-4302`（OCR）、`PKG-8001`（manifest 非法）、`UTH-1001`（文档里的写法，疑似 AUTH-1001 笔误）。

---

## 3. 角色 → 权限 key 对照（`packages/core/src/index.ts ROLE_PERMISSIONS`）

`platform_admin` = `*`（全部）。✓ = 有；空 = 无。

| 权限 key | org_admin | builder | operator | auditor | user | 使用该 key 的接口 |
|---|---|---|---|---|---|---|
| agent.view | ✓ | ✓ | ✓ | ✓ | ✓ | #12 #13 #15 |
| agent.manage | ✓ | ✓ | | | | #14 #16 |
| agent.publish | ✓ | ✓ | | | | #17 #18 |
| agent.run | ✓ | ✓ | ✓ | | ✓ | #19 |
| skill.view | ✓ | ✓ | | | | #30 #32 |
| skill.manage | ✓ | ✓ | | | | #31 #33 #34 |
| mcp.view | ✓ | ✓ | | | | #26 |
| mcp.manage | ✓ | ✓ | | | | #27 #28 #29 |
| tool.view | ✓ | ✓ | | | | #35 |
| tool.manage | ✓ | ✓ | | | | #36 |
| model.view | ✓ | ✓ | | | | #20 |
| model.manage | ✓ | ✓ | | | | #21–#25 |
| run.view | ✓ | ✓ | ✓ | ✓ | ✓ | #37 #38 #39 |
| run.cancel | ✓ | | ✓ | | | #40 |
| approval.view | ✓ | | ✓ | | | #41 |
| approval.decide | ✓ | | ✓ | | | #42 |
| schedule.view | ✓ | ✓ | ✓ | | | #43 #44 |
| schedule.manage | ✓ | ✓ | | | | #45–#48 |
| schedule.run | ✓ | ✓ | ✓ | | | #49 |
| apikey.view | ✓ | | | | | #50 #52 #55 |
| apikey.manage | ✓ | | | | | #51 #53 #54 #56 |
| plugin.install | ✓ | ✓ | | | | #67 |
| user.view | ✓ | | | | | #57 |
| user.manage | ✓ | | | | | #58 #59 |
| audit.view | ✓ | | | ✓ | | #64 |
| usage.view | ✓ | ✓ | | ✓ | | （没有接口使用） |
| **service_account.manage** | | | | | | #69–#72（仅 platform_admin） |
| **role.view** | | | | | | #60（仅 PA） |
| **org.view** | | | | | | #61（仅 PA） |
| **sso.manage** | | | | | | #62 #63 #65（仅 PA） |
| **package.view** | | | | | | #66（仅 PA；builder/org_admin 能装插件但不能列插件） |
| **plugin.uninstall** | | | | | | #68（仅 PA） |

默认数据范围（`defaultDataScope`）：platform_admin、auditor → `all`；user → `self`；其他 → `org`。服务账号只能 `org`/`all`。应用身份（API Key）role 固定 `user`、dataScope `app`、权限按 scope（`agents:read`、`runs:create`、`runs:read`、`runs:cancel`）。
代码里**没有**「服务账号」这种登录身份：服务账号只作为定时任务 Run 的执行主体，不能调用任何 HTTP 接口。

---

## 4. 代码与 `docs/03-api/admin-api.md` 不一致之处（静态对照）

> 总体：admin-api.md 描述的是目标形态（`/admin/v1/*`、`packages/contracts` Zod、OpenAPI 生成），大部分资源路径和代码（`/admin/api/*`）对不上；只有第 9 节「待审批列表（当前实现）」和第 10 节 `GET /schedules/{id}` 是按当前代码写的。下面只列能逐条核对的差异。

**A. 全局约定**

1. Base URL：文档 `/admin/v1`；代码 `/admin/api`。会话接口：文档 `GET /session`、`GET /me`；代码只有 `GET /auth/session`，没有 `/me`。
2. 文档说自动化/CLI 可用 `Authorization: Bearer` 调管理 API（`/auth/token` 签发）；代码管理接口只认 Cookie，没有 `/auth/token`。
3. Cookie：文档写 `Secure`；代码只在 NODE_ENV=production 时加 Secure。
4. 「所有变更写审计」「审计记录 actor、资源、前后值、IP、UA、traceId」：代码有 6 个写接口不写审计（见 1.15），审计表没有 IP/UA/traceId/前后值列。
5. 「响应头返回 `X-Request-Id`」：代码没有设置这个响应头（静态推断）。
6. 错误结构：文档 `{code,message,requestId,details,remedy}`；代码是 `{code,message,requestId,details,retryable}`，没有 `remedy`；500 时没有 `details`。
7. HTTP 状态：文档列 413（超限）、415、422；代码没有任何地方返回这几个，坏 JSON/超 2MiB/错 Content-Type 被兜底成 500 SYS-9001（静态推断）。open-platform.md 写的 `OPN-4504`(413)、`OPN-4505`(415) 代码里不存在。
8. 创建返回 `201`：代码创建类全部返回 200（open 的 runs 返回 202）。
9. 乐观并发 `If-Match` / `revision` / 409 CFG-8503：代码不读 `If-Match`，没有 revision 字段。
10. 幂等 `Idempotency-Key` 适用于「创建类 POST」：代码只有 `/open/v1/agents/:key/runs` 和 `/invoke` 支持。
11. 分页约定 `pageSize` 默认 20、最大 100、`{items,page,pageSize,total}`：代码只有 `/admin/api/approvals` 实现；其余列表都是一次返回全部 `{items}`（agents、users、apps、schedules 等没有分页也没有 limit）。文档写的例外 `/admin/api/runs`、`/admin/api/audit` 用 `?limit=`：与代码一致，但文档没说明非法 limit 的行为（代码会 500，见 #37 #64）。
12. 筛选 `q`/`orgId`/`type`/`from`/`to`、排序 `sort=`：代码只有 runs 的 `status`，其余全部不支持。
13. 软删除 / `DELETE` 接口：代码没有任何 DELETE 路由。

**B. 权限 key 不一致**

14. 创建 Agent 版本：文档 `POST /agents/{id}/versions` 需 `agent.manage`；代码 #17 要 `agent.publish`。
15. 用户：文档 `GET /users` 需 `org.view`、`POST/PATCH /users` 需 `org.manage`；代码用 `user.view`/`user.manage`（`org.manage` 在代码里不存在）。
16. 文档的权限码目录里没有 `user.view`、`user.manage`；代码的 `ROLE_PERMISSIONS` 里没有 `package.view`、`plugin.uninstall`、`role.view`、`org.view`、`sso.manage`、`service_account.manage`，导致这些接口只有 platform_admin 能用——文档说 org_admin 管「本组织及子部门的用户」，但服务账号、组织树等接口 org_admin 拿不到。
17. Webhook：文档 `webhook.manage`；代码用 `apikey.view`/`apikey.manage`（#50 #51）。
18. 审计：文档路径 `/audit-logs`；代码 `/admin/api/audit`（权限 key 一致：audit.view）。
19. 文档说应用停用、Scope 不足 → 403 POL-2001（open-platform.md）；代码应用停用返回 **401 AUTH-1001**「应用已停用」。

**C. 数据范围不一致**

20. 文档：org_admin 管「本组织及子部门的用户、Agent、配额」；代码 `GET/PATCH /admin/api/users`（#57 #59）、apps 全组（#50–#56）、`GET /admin/api/audit`（#64）、`/admin/api/dashboard`（#12）**不按部门过滤**，跨部门 id 不会返回 404。
21. 文档第 11 节：「应用数据范围固定为 app」——代码一致；但文档没说管理端 apps 按部门隔离与否，代码是全局。
22. 文档第 9 节：approvals 的数据范围「和 `GET /runs/{id}` 的可见性一致」，org 看本部门及下级——与代码一致；但 schedules（R-sched）和 service-accounts（R-sa）是**精确等于本部门、不含子部门**，与 runs 规则不同，文档第 10 节只写「按列表同一数据范围」，没说明不含子部门。
23. 第 10 节：「手动 run 先按调用者数据范围查任务，查不到 → 404（platform_admin 除外）」——代码按 dataScope=all 放行，不是按角色；任何 dataScope=all 且有 schedule.run 的非 PA 用户（例如被设成 all 的 operator）同样放行。

**D. 行为不一致**

24. 审批决定：文档 body `"decision": "approve"`；代码只接受 `approved`/`rejected`（传 `approve` → 400）。并发决定：文档 `409 APR-2103`、「重复决定幂等返回当前结果」；代码第二次决定返回 **409 CFG-8503**，不幂等。超时 `APR-2102`：代码不存在。
25. 审批：文档「响应里永远不包含原始参数（args_json）」只约束 approvals 列表；但 `GET /admin/api/runs/:id`（#38）的 `toolCalls[].args`/`result` 返回原始工具参数和结果，approval.view 没有、run.view 有的角色（builder、auditor、user）能看到原文。
26. 定时任务：文档「创建：默认停用」——一致；「修改 `If-Match`」——代码不支持；「所有操作写审计；修改/启停记录前后值」——enable/disable 不写审计，update 只记新值；文档 `DELETE /schedules/{id}`、`/runs`、`/next-runs` 代码都没有。
27. 定时任务：文档「绑定 platform_admin 服务账号 → 400 SCD-4804；存量任务触发时同码自动暂停」——手动 `/run` 遇到 PA 服务账号时代码返回 **409** SCD-4804（`buildScheduleIdentity`），与 400 不一致。
28. `GET /schedules/{id}`：文档「无权限 → 403，跨部门与不存在完全相同的 404」——与代码一致。
29. 开放平台管理：文档创建密钥响应含 `keyId`、`scopes`、`expiresAt`、`createdAt`；代码返回 `{id, key, prefix, warning}`，没有过期时间。文档 `GET /api-apps/{appId}`、`DELETE`、rotate、revoke、quota、usage、requests 代码都没有。
30. 第 4 节插件：文档是 packages/installations 体系，支持 `dryRun`、步骤状态；代码只有 `POST /admin/api/plugins/install`（同步、无 dryRun、失败不回滚）和 `/uninstall`（只改状态，不存在也 200）。
31. 第 6 节 MCP：文档路径 `/mcp-servers`，有 test、tools、health 等；代码 `/admin/api/mcp`，只有 list/create/patch/refresh。
32. 第 7 节工具源：文档 `POST /tool-sources`、`/tool-sources/parse`；代码只有 `POST /admin/api/tool-sources/import`。
33. 第 8 节模型：文档路径 `/llm/providers`、`/llm/models`、`/llm/routes`；代码 `/admin/api/providers`、`/admin/api/providers/:id/models`、`/admin/api/models/:id`，没有 routes、usage、health。
34. 第 12 节：文档的组织管理（POST/PATCH/DELETE org-units）、groups、roles、data-scopes、policies 代码都没有；`GET /admin/api/role-mappings` 和 `POST /admin/api/role-mappings`、`GET /admin/api/sso` 在文档里对应 `/sso/role-mappings`、`/sso/status`，路径不同。
35. 第 13 节：secrets、settings、version、openapi.json（管理端）代码都没有。
36. 错误码表：见 2.3，文档里 11 个码代码中不存在；代码里 SCD-4802/4804、CON-4702~4707、OPN-4502、SSO-1202~1211、MDL-3003/3004、RUN-7004、MCP-4101/4102 在 admin-api.md 里没有出现（部分在 system-design.md）。

---

## 5. 静态读码时顺带看到的可疑点（供写用例参考，未验证，未定级）

只列和本轮范围（认证、权限、跨部门、参数边界、坏请求、报错泄露、审计）相关的：

1. **权限提升**：`POST /admin/api/users`、`PATCH /admin/api/users/:id` 的 `dataScope` 不校验，org_admin 可创建或把用户改成 `dataScope: "all"`（看全公司 Run/审批/定时任务）。
2. **跨部门改用户**：`PATCH /admin/api/users/:id` 不查目标部门，org_admin 可对其他部门用户（包括 platform_admin，只要传 `role:"user"`）改角色、停用。
3. **跨部门操作应用**：apps 一组全局，org_admin 可读/改其他部门的应用、给它签发 API Key、重放其 Webhook。
4. **integration 无授权**：只要 Connector 主体映射到任何用户（含 auditor、已停用用户），就能列出全部已发布 agent、对任意部门的 agent 创建 Run，且不写审计。
5. **`/admin/api/runs` 以应用身份不带 appId 返回全部**：`runFilterFor` 对 `type:"app"` 返回 `{appId: principal.appId}`，`appId` 为 undefined 时 `listRuns` 不加条件 → 全表。但 admin 路由只认 Cookie 会话，会话只能由 `createSession(toPrincipal(user))` 产生（type 恒为 user），API Key 身份到不了 admin 路由；`authenticateApiKey` 总是设置 `appId`。静态结论：**当前 HTTP 路径不可达**，属潜在缺陷（防御性不足），需要测试用例确认 Bearer API Key 调 `/admin/api/runs` 返回 401。
6. **参数边界 500**：`/admin/api/runs?limit=abc|1.5`、`/admin/api/audit?limit=-1|1.5|abc`、PATCH schedule 非法 cron + active、撞唯一键的 6 处（apps key、users username、agent/skill version、model key、schedule key）、坏 JSON / 超 2MiB / 错 Content-Type 被兜底成 500。
7. **报错泄露**：500 响应体只有固定「内部错误」，不含堆栈；但 `POST /admin/api/mcp` 的 `warning` 和 `last_error` 返回 `String(error)`（可能含内部地址/端口）；`providers/:id/test` 失败时返回 `String(error)`。服务日志 `request.log.error(error)` 会写完整错误（含 SQL 片段）。Fastify 默认请求日志不记录 headers/body（静态推断：logger 未配置 serializers，默认 req 序列化只含 method/url/host/remoteAddress）。
8. **审计缺口/敏感值**：见 1.15。
9. **会话不随用户状态失效**：停用、降权后已登录会话在 8h 内继续有效。
10. **plugins/install 部分写入**：缺顶层 key 时已创建的 agent/skill/mcp/provider 留在库里，没有审计。
11. **`/auth/oidc/login?returnTo=//evil.example`** 能通过 `startsWith("/")`，回调时 `reply.redirect("//evil.example")`（协议相对地址，开放重定向；超出本轮范围，交安全专家）。
