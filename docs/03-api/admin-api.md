# Forge 管理 API

版本：1.0　日期：2026-10-21　状态：待评审

> 控制台与自动化工具使用的内部接口。对外集成使用 [open-platform.md](open-platform.md)。本文定义资源面与约定，字段细节以 `packages/contracts` 的 Zod Schema 和生成的 OpenAPI 为准。

## 1. 认证与会话

- Base URL：`https://{forge-host}/admin/v1`
- 控制台使用 **BFF 会话**：浏览器通过统一 SSO（OIDC 授权码 + PKCE）登录，只持有 HttpOnly 会话 Cookie（始终 HttpOnly、`SameSite=Lax`；`Secure` 仅在 `NODE_ENV` 恰为 `development`/`test` 时关闭以便本地 http，其余情况（含未设置）一律开启），不接触 OIDC Access Token。
- 变更请求必须带 CSRF Token：`X-CSRF-Token`（从 `GET /session` 获取）。
- 自动化/CLI 使用短期 Bearer Token（`Authorization: Bearer ...`），由 `/auth/token` 或在部署配置中签发；不使用用户密码。
- 未认证：`401 AUTH-1001`；已认证但无权限：`403 POL-2001`。
- 会话身份实时读取（当前实现，S-38）：会话里只保存用户 id、CSRF Token 和过期时间，不保存登录时的角色/部门/数据范围快照。每个需要身份的请求（`/admin/api/*`、`GET /auth/session`）都用 `loadActivePrincipal` 重新读库（一条查询：`users` JOIN `org_units`，加部门链子查询），拿当前的角色、部门和数据范围来判定权限和数据范围；登录后被降级、换部门，下一次请求立即按新值生效。用户不存在、`status` 不是 `active`（停用、已删除）、所属部门不存在或部门链上任一级 `status` 不是 `active` 时返回 `401 AUTH-1001`，并删除该会话（之后即使恢复也要重新登录）。本地登录同样经过这一检查，不满足时和密码错误一样返回 401。CSRF 校验和注销只读内存里的会话，不查库。`/integration/v1` 的 Connector 主体用的是同一个函数（不满足时为 `403 CON-4706`）。
- 身份查库失败（当前实现）：会话认证、`/integration/v1` 的 Connector 主体、本地登录在查库出错（连接断开、超时等任何异常）时返回 `503 SYS-9003「身份校验暂时不可用，请稍后重试」`（`retryable: true`），不当成用户不可用：不返回 401/403、不当成密码错误、**不删除会话**，数据库恢复后同一个 Cookie 继续可用。响应里不带数据库地址等内部信息。
- OIDC 登录回跳（当前实现，S-30）：`GET /auth/oidc/login?returnTo=` 和回调里的 `returnTo` 只接受本站路径：必须以单个 `/` 开头，不能以 `//`、`/\` 开头（百分号解码一次后同样检查，如 `/%2F%2Fevil.example`），不能含控制字符，且 `new URL(returnTo, FORGE_PUBLIC_URL)` 的 origin 必须等于本站；任一条不满足都回落到 `/next/`。
- 所有变更写审计；响应头返回 `X-Request-Id`。
- 部门子树（AB，I-SCOPE-13 / I-SCOPE-14）：`orgSubtreeIds` 按路径字面匹配（`path = ? OR path LIKE ? ESCAPE '!'`，参数里的 `!`、`%`、`_` 先转义，后缀固定带 `/`），部门 key 里的 `_`、`%` 不再是通配符，`/a/b` 不会匹配 `/a/bc`，子部门 `/a/b/c` 仍在范围内；部门链启用检查同样按 `/` 分隔判断祖先。
- 审计请求信息（当前实现，P3-10）：处理请求期间写的每条审计，`details_json` 里额外带 `ip`、`userAgent`（最多 512 个字符，超出截断；没有该请求头为 `null`）、`requestId`（即响应头 `X-Request-Id` 的值）三个键，不新增列、不迁移；与调用方传入的同名键冲突时以这三个值为准。`ip` 取 `request.ip`：默认不信任代理，`X-Forwarded-For` 被忽略（防止伪造），只有以 `trustProxy` 选项构建应用时才按 `X-Forwarded-For` 取客户端地址（目前只能在代码里设置，尚无环境变量）。请求之外写的审计（Runtime、脚本）不带这三个键。
- 补齐的审计 action（Y，当前实现）：`auth.logout`（有有效会话时才写，actor 为该用户；写审计失败不影响登出）、`schedule.enable`、`schedule.disable`、`open.run.cancel`（actor 为应用）、`integration.run.create`、`integration.run.cancel`（actor 为映射用户）。只在操作成功后写；409 等失败不写。
- 管理 API **不向 Agent Connector 入站开放**；集成调用使用专用 `/integration/v1`，见 [sso-and-connector.md](../02-architecture/sso-and-connector.md)。

```http
GET /admin/v1/session
```

```json
{
  "user": { "id": "usr_01J...", "displayName": "李工", "email": "li@acme.internal" },
  "orgUnits": [{ "id": "org_01J...", "name": "法务部", "path": "/root/legal", "role": "org_admin" }],
  "roles": ["builder", "org_admin"],
  "permissions": ["agent.view", "agent.manage", "agent.publish", "plugin.install", "..."],
  "dataScopes": [
    { "resourceType": "run", "actions": ["read"], "scope": "org_tree" },
    { "resourceType": "message", "actions": ["read"], "scope": "self" }
  ],
  "csrfToken": "csrf_...",
  "features": { "knowledge": false, "schedules": false }
}
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/session` | 当前用户、组织、角色、权限、CSRF、功能开关 |
| POST | `/auth/logout` | 注销会话 |
| GET | `/me` | 当前用户简要信息（不含 CSRF） |

## 2. 通用约定

| 项 | 约定 |
| --- | --- |
| 内容类型 | `application/json; charset=utf-8`；上传 `multipart/form-data` |
| ID | 当前实现（K-33）：3 位小写前缀 + `_` + ULID 前 22 位（大写 Crockford），共 26 位，例如 `agt_01M5PK6G1GPZ3APBN3QNXR`；seed 数据是 26 位纯 ULID。正则与前缀列表由 `@forge/core`（`packages/core/src/ids.ts`）导出：`ID_PATTERN_SOURCE` / `ID_PATTERN`、`ID_PREFIXES`；路径参数 `:id` 都是这种 ID，`:key`（仅 `/open/v1/agents/:key`、`/runs`、`/invoke`）是 Agent key（slug），见 `PATH_PARAM_KINDS` |
| 时间 | ISO 8601 UTC |
| 分页 | 新的管理端列表用 `?page=&pageSize=`（`page` 从 1 开始；`pageSize` 默认 20，最大 100，超过 100 按 100 处理，不报错）；响应 `{ items, page, pageSize, total }`。历史例外：`/admin/api/runs` 和 `/admin/api/audit` 仍只支持 `?limit=`，响应只有 `{ items }`；`limit` 必须是正整数（只含数字），runs 最大 200、audit 最大 500，不传时分别为 50、100；`abc`、`1.5`、`-1`、`0`、空串、`1e2` 或超过最大值都返回 `400 CFG-8501`（不截断）。`cursor` / `nextCursor` 只用于开放平台接口（见 open-platform.md） |
| 筛选 | `q`、`status`、`orgId`、`type`、`from`、`to`；具体见各资源 |
| 排序 | `sort=field:asc|desc`；仅白名单字段 |
| 乐观并发 | 资源含 `revision`；更新带 `If-Match: "rev-3"`；冲突 `409 CFG-8503` |
| 幂等 | 创建类 `POST` 支持 `Idempotency-Key`，24h；同键异体 `409 OPN-4503` |
| 软删除 | 配置类资源默认软删除；列表不返回；`?includeDeleted=true` 仅管理员 |
| 长任务 | 安装、导出等返回 `jobId`/资源状态；轮询详情或订阅 SSE |
| 错误 | `{ "error": { "code", "message", "requestId", "details", "remedy" } }` |
| 审计 | 所有写操作记录 actor、资源、前后值、IP、UA、traceId |

### 2.1 出站请求（SSRF 拦截，S-46 ~ S-49，当前实现）

服务端发出的所有 HTTP 请求都经过同一个出站校验（`@forge/core` 的 `assertOutboundAllowed` / `safeFetch`）：

| 出站入口 | 保存配置时（静态校验） | 发请求时（完整校验） |
| --- | --- | --- |
| MCP | `POST /admin/api/mcp`、`PATCH /admin/api/mcp/:id`（`url`）、能力包安装中的 `mcp[].url` | 创建后的 discover、`POST /admin/api/mcp/:id/refresh`、运行时 `tools/call` |
| 模型 Provider | `POST /admin/api/providers`、`PATCH /admin/api/providers/:id`（`baseUrl`）、能力包安装中的 `providers[].baseUrl` | `POST /admin/api/providers/:id/test`、运行时模型调用 |
| OpenAPI 工具源 | `POST /admin/api/tool-sources/import`（`baseUrl` 或 `servers[0].url`） | 运行时 OpenAPI 工具调用 |
| `web_fetch` 内置工具 | — | 每次调用 |
| Webhook | `POST /admin/api/apps`、`PATCH /admin/api/apps/:id`（`webhookUrl`） | 投递（worker）和 `POST /admin/api/webhook-deliveries/:id/replay` |
| OIDC | — | discovery、token endpoint、JWKS（`OIDC_ISSUER` 来自环境变量） |

- 只允许 `http` / `https`；`file://`、`gopher://` 等一律拒绝。
- 拒绝的地址：回环 `127/8`、`::1`；私网 `10/8`、`172.16/12`、`192.168/16`、`fc00::/7`（含 `fd00::/8`）；链路本地 `169.254/16`（含云元数据 `169.254.169.254`）、`fe80::/10`；`0.0.0.0/8`；CGNAT `100.64/10`；IPv4-mapped / IPv4-compatible IPv6（`::ffff:0:0/96`、`::/96`）；以及 NAT64、6to4、组播、保留段。十进制 / 八进制 / 十六进制写法的 IP（如 `2130706433`、`0177.0.0.1`、`0x7f000001`）先按 URL 标准规范化成点分形式再判断。
- 静态校验只看字面 IP 和 `localhost`、`*.localhost`、`*.local`、`metadata.google.internal` 这类主机名，不做 DNS。完整校验会做 DNS 解析，解析出的**每一个**地址都必须是公网地址。
- 防 DNS rebinding：解析一次、校验全部结果，连接时用自定义 `lookup` 把 socket 固定到这批已校验的地址上，不会再做第二次解析；TLS 的 SNI 和证书校验仍按原主机名。
- 跳转：手动跟随，最多 5 跳，每一跳都重新做完整校验（跳到私网、元数据或 `file://` 都会被拒绝）；Webhook 不跟随跳转。跨源跳转会去掉 `Authorization` / `Cookie`。
- 被拒绝时（AD 后的口径）：
  - 管理接口（保存 MCP / Provider / 工具源 / Webhook 地址、MCP refresh、Provider test）返回 `400 HTP-4003「目标地址不允许（内网/回环/元数据）」`；运行时工具调用（MCP、OpenAPI、web_fetch）返回 `errorCode: HTP-4003` 的工具结果；模型调用该步失败，Run 最终以 `HTP-4003` 结束（不可重试）。
  - Webhook 投递记为 `failed`（不重试），新列 `error_code = HTP-4003`（`GET /admin/api/apps/{id}/webhook-deliveries` 返回 `errorCode`），`errorMessage` 以 `HTP-4003` 开头。其他失败：非 2xx 记 `HTP-4001`（4xx）/ `HTP-4002`（5xx、429、408），网络错误记 `HTP-4002`；重放会清空 `error_code`。
  - OIDC（discovery、token、JWKS）：浏览器整页跳转的 `GET /auth/oidc/login` 和 `GET /auth/oidc/callback` 一律 `302` 到 `/next/sign-in?ssoError=HTP-4003`，合法的 `returnTo`（按 S-30 校验，callback 用登录时保存的那个）URL 编码后放进 `redirect` 参数（控制台登录页读的是 `redirect`，AE），如 `/next/sign-in?ssoError=HTP-4003&redirect=%2Fnext%2Fagents`；不合法的、或等于默认 `/next/` 的不带该参数；不再输出 `returnTo` 参数。identity 层对 JSON 调用方抛 `502 HTP-4003`（上游 IdP 问题）；目前没有管理端「测试 OIDC 配置」这类 JSON 接口。私有部署的 IdP 必须把它的 `host:port` 加进 `OUTBOUND_ALLOWLIST`，否则 SSO 无法登录。
  - **OIDC 回调的其他错误**（当前实现，P3-04）：`GET /auth/oidc/callback` 的每个错误分支同样 `302` 到 `/next/sign-in?ssoError=<码>`，`redirect` 规则同上：IdP 回 `error=`（如 `access_denied`）→ `SSO-1212`；缺 `code` / `state` → `SSO-1203`；state 过期、令牌交换失败等 identity 层错误 → 原错误码（`SSO-1201`～`SSO-1211`）；意外异常或不在白名单的码 → `SYS-9001`。白名单为 `apps/api/src/routes/auth.ts` 导出的 `SSO_ERROR_CODES`（`HTP-4003`、`SSO-1201`～`SSO-1212`、`SYS-9001`）。跳转地址只带错误码，不带 `error`、`error_description` 或异常信息。只有 API 客户端（`Accept` 含 `application/json` 且不含 `text/html`）继续拿 JSON 错误（如 `400 SSO-1203`、`401 SSO-1204`、`401 SSO-1212`）；`HTP-4003` 分支不论 `Accept` 都跳转（不变）。`GET /auth/oidc/login` 的未配置（`503 SSO-1201`）和 discovery 失败（`502 SSO-1202`）仍为 JSON。IdP 回传的原始 `error` / `error_description` / `error_uri` 不出现在跳转 URL 和任何响应里（JSON 错误只有我方固定文案「身份提供方拒绝了登录」，`details` 为 null）；进日志前先净化：`error_description`、`error_uri` 一律 `[REDACTED]`，`error` 只有是纯 OAuth 错误码（`[A-Za-z0-9_.-]`，至多 64 字符，如 `access_denied`）时原样记录，否则记为 `[REDACTED]`（请求 URL 日志和单独的 `oidc callback: identity provider returned an error` 告警行的 `idpError` 字段同一规则）。
  - 返回给客户端的内容（错误响应、工具结果、投递记录、跳转地址）都不带解析出的 IP。服务端日志记一条 `outbound.blocked`：`host`、`port`、`protocol`、`addresses`（解析出的或字面的 IP）、`reason`（`scheme`、`invalid_url`、`local_hostname`、`loopback`、`private`、`metadata`、`link_local`、`cgnat`、`unspecified`、`ipv4_mapped`、`ipv4_embedded`、`multicast`、`reserved`；跳转中被拒为 `redirect`，另记 `targetReason` 和 `hop`）。不记 URL 的路径和查询串。
- 白名单：环境变量 `OUTBOUND_ALLOWLIST`，逗号分隔、每项必须是精确的 `host:port`（IPv6 写成 `[::1]:9000`，端口 1–65535），默认空（全部按规则拦截）。不支持通配符、CIDR、只写 host；有无效项时配置加载失败、进程启动即报错退出；错误信息逐条只点出第几项、该项的值和原因（如 `OUTBOUND_ALLOWLIST 第 2 项 "10.0.0.0/8" 不合法：不支持 CIDR 网段，只能写精确的 host:port`），不回显整行配置。只放行完全一致的主机和端口（默认端口按 80/443 计）：白名单里的地址 302 跳到别的内网地址、或别的主机名解析到内网 IP，照样拦截；白名单不放开非 http(s) 协议。旧开关 `TOOL_ALLOW_PRIVATE_NETWORK` 不再绕过出站校验。

**未声明字段**（当前实现，P1）：管理端和登录相关的写接口（`/admin/api/*` 的全部 POST/PATCH，以及 `/auth/local/login`、`/auth/logout`，共 37 条）请求体顶层只接受文档列出的字段，多出任何字段 → `400 CFG-8501「不支持的字段: <字段名>」`，`details.field` 为该字段名，不写库、不写审计（拒绝，不是静默丢弃）。不需要请求体的动作接口（退出登录、取消 Run、定时任务 enable/disable/run、MCP refresh、Provider test、Webhook 重放、插件卸载）不带请求体或带 `{}` 都正常，带任何字段即 400。外部接口（Connector `/integration/v1/*`、开放平台 `/open/*`，共 5 条写接口）字段和类型同样校验，但多出的字段不报错（兼容外部调用方）。以下字段已从接口里去掉，传了就是 400：建 Agent 的 `status`、`PATCH /agents/{id}` 的 `instructions`/`version`（改提示词请走 `POST /agents/{id}/versions`）、`PATCH /schedules/{id}` 的 `agentId`。布尔字段（如 `apiEnabled`、`publish`、`enabled`）必须是 JSON `true`/`false`，`"yes"`、`"true"`、`"false"`、`1`、`null` 都是 `400 CFG-8501`。`spec`、`input` 接受 JSON 对象或 JSON 文本（字符串会按 JSON 解析）。嵌套的自由 JSON（`spec`、`input`、`headers`、`manifest`、插件 `resources` 内的对象）不在此限。校验顺序不变：401 → 403 → 404 → 400。

**未知路由**（当前实现，P3-01，所有入口：`/admin/api/*`、`/open/v1/*`、`/integration/v1/*`、`/auth/*` 及其他非 `/next/` 路径）：返回 `404 RUN-7001「资源不存在」`，响应体与其他错误统一为 `{ error: { code, message, requestId, details: null, retryable: false } }`，不回显路径和 query（脱敏后的路由行只进日志）；已有路径但方法不对（如对只有 GET 的路由发 DELETE）同样是这个 404，不返回 405。`/next/*` 仍走 SPA 回落。

**请求体解析失败**（当前实现，K-09 / I-CSRF-06，所有入口：管理端、登录、开放平台、Connector）：体积超过上限（JSON 2 MiB）→ `413 OPN-4504「请求体过大」`；Content-Type 声明为 JSON 但内容不是合法 JSON → `400 CFG-8501「请求体不是合法的 JSON」`；声明为 JSON 却是空体 → `400 CFG-8501「请求体为空，但 Content-Type 声明为 JSON」`；Content-Type 不受支持（如 `text/plain`、`application/xml`、`application/x-www-form-urlencoded`），或带了请求体却没有 Content-Type → `415 OPN-4505「不支持的 Content-Type」`（I-DOC-16；`application/json; charset=utf-8` 正常解析，不带请求体也不带 Content-Type 的 POST 照常处理）。不再返回 `500 SYS-9001`。中间件顺序不变：解析在 CSRF 校验之前，所以坏请求体即使没带 CSRF 令牌也先得到上面的 400/413/415；能解析的请求体没带 CSRF 仍是 403。

**HTTP 状态**：`200` 成功、`201` 创建、`202` 已接受、`204` 无内容、`400` 校验、`401` 未登录、`403` 权限、`404` 不存在、`409` 冲突/状态、`413` 超限、`422` 语义错误、`429` 限流、`500` 内部。

## 3. Agent

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/agents` | 列表（`status`、`orgId`、`q`、`apiEnabled`） | `agent.view` |
| POST | `/agents` | 创建草稿 | `agent.manage` |
| GET | `/agents/{agentId}` | 详情（含当前版本、绑定） | `agent.view` |
| PATCH | `/agents/{agentId}` | 修改元数据/启停/API 开放设置 | `agent.manage` |
| DELETE | `/agents/{agentId}` | 软删除；有 API 调用历史需 `force` | `agent.manage` |
| POST | `/agents/{agentId}/duplicate` | 复制为新草稿 | `agent.manage` |
| GET | `/agents/{agentId}/versions` | 版本列表 | `agent.view` |
| POST | `/agents/{agentId}/versions` | 从草稿/旧版本创建新版本 | `agent.manage` |
| GET | `/agents/{agentId}/versions/{versionId}` | 版本详情 | `agent.view` |
| PATCH | `/agents/{agentId}/versions/{versionId}` | 仅草稿可改 | `agent.manage` |
| POST | `/agents/{agentId}/versions/{versionId}/publish` | 发布（需 changelog） | `agent.publish` |
| POST | `/agents/{agentId}/versions/{versionId}/deprecate` | 废弃 | `agent.publish` |
| POST | `/agents/{agentId}/rollback` | 重新发布指定旧版本 | `agent.publish` |
| POST | `/agents/{agentId}/test-runs` | 用草稿或指定版本试运行 | `agent.run` |
| POST | `/agents/{agentId}/enable` / `disable` | 启停新 Run | `agent.manage` |
| GET | `/agents/{agentId}/export` | 导出 Agent 包（不含公共依赖） | `agent.view` |
| GET | `/agents/{agentId}/bindings` / `PUT` | 组织/角色可见绑定 | `agent.manage` |

**创建 Agent**

```http
POST /admin/v1/agents
If-Match: "rev-1"
```

```json
{
  "key": "contract-reviewer",
  "name": "合同审查助手",
  "description": "审查合同条款并输出风险清单",
  "icon": "contract",
  "category": "legal",
  "apiEnabled": false
}
```

**保存/发布版本**（`spec` 结构见插件文档中的 Agent 定义）

```http
POST /admin/v1/agents/agt_01J.../versions
```

```json
{
  "basedOnVersionId": null,
  "label": "0.1.0",
  "instructions": "你是一名合同审查专家……",
  "spec": {
    "model": { "route": "legal-default", "params": { "temperature": 0.2 } },
    "skills": ["contract-review"],
    "toolsets": [
      { "mcp": "doc-parser", "allow": ["parse_pdf", "ocr_image"] },
      { "openapi": "erp", "allow": ["get_contract", "submit_approval"] }
    ],
    "approval": { "highRisk": ["submit_approval"], "timeout": "72h" },
    "limits": { "maxSteps": 50, "maxCostUsd": 2 },
    "output": { "schema": { "type": "object", "properties": { "risks": { "type": "array" } } } }
  }
}
```

发布：

```http
POST /admin/v1/agents/agt_01J.../versions/ver_01J.../publish
```

```json
{ "changelog": "新增付款条款检查", "publish": true }
```

**试运行**：`POST /agents/{id}/test-runs`

```json
{
  "versionId": "ver_01J...",
  "draft": false,
  "input": { "text": "审查这份合同", "files": ["file_01J..."] }
}
```
返回 `{ "runId": "run_01J...", "eventsUrl": "/admin/v1/runs/run_01J.../events" }`。草稿试运行不会改变已发布版本。

Agent 状态与运行（当前实现，I-AGT-11 / 11b / 11c）：

- `PATCH /admin/api/agents/{id}` 的 `status` 只接受 `active` 和 `disabled`，其他值（包括大小写不同、空串、非字符串）返回 `400 CFG-8501`，不修改。
- Agent 的 `status` 不是 `active` 时，`POST /admin/api/agents/{id}/run`、开放平台 `POST /open/v1/agents/{key}/runs` 和 `/invoke`、`POST /integration/v1/runs` 都返回 `409 CFG-8503「Agent 已停用，不能运行」`，不建 Run、不写审计。判定在可见性之后：看不到的 Agent 仍是 404。
- Integration 入口的 Agent 范围（I-INT-17）：`GET /integration/v1/agents` 与 `POST /integration/v1/runs` 复用 `agentAccessible`，按映射用户所在部门及其子部门（加上无主 Agent）判定；范围外的 Agent 不出现在列表里，建 Run 返回与不存在相同的 `404`，不建 Run。列表也不再列出已停用的 Agent。Integration 不检查 `api_enabled`：该开关只管开放平台的 App Key 入口（`/open/v1/*`）；integration 走 Connector JWT 加用户映射，权限按映射用户的身份（角色、dataScope）和所在部门子树判断。
- 无主 Agent（`owner_org_unit_id` 为空，I-AGT-13）：`PATCH /admin/api/agents/{id}`、`POST /admin/api/agents/{id}/versions`、`POST /admin/api/agents/{id}/publish` 只有数据范围为全部（`dataScope=all`）的调用者能执行（P3-17，与 P0-03 平台级资源同一口径，按 dataScope 而不是角色名判断），其他调用者返回 `403 POL-2001`，不写库、不写审计；读取、运行、建定时任务不受影响。

## 4. 能力包与安装

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| POST | `/packages` | 上传 `.forgepkg`（multipart）或提交 URL | `plugin.install` |
| GET | `/packages` | 包列表（`type`、`q`） | `package.view` |
| GET | `/packages/{packageId}` | 包详情与版本 | `package.view` |
| GET | `/packages/{packageId}/versions/{versionId}` | 版本详情、manifest、校验结果 | `package.view` |
| POST | `/packages/{packageId}/versions/{versionId}/validate` | 重新校验 | `plugin.install` |
| POST | `/packages/{packageId}/versions/{versionId}/deprecate` | 标记弃用 | `plugin.install` |
| POST | `/installations` | 安装（支持 `dryRun`） | `plugin.install` |
| GET | `/installations` | 安装列表（作用域、状态） | `package.view` |
| GET | `/installations/{id}` | 状态、步骤、错误、diff | `package.view` |
| POST | `/installations/{id}/enable` / `disable` | 启停 | `plugin.install` |
| POST | `/installations/{id}/upgrade` | 升级到版本 | `plugin.install` |
| POST | `/installations/{id}/rollback` | 回滚到历史版本 | `plugin.install` |
| POST | `/installations/{id}/uninstall` | 卸载（支持 `dryRun`） | `plugin.uninstall` |
| GET | `/installations/{id}/references` | 引用方 | `package.view` |
| GET | `/installations/{id}/diff` | 当前/目标版本差异 | `package.view` |

卸载插件（当前实现 `POST /admin/api/plugins/{id}/uninstall`，#68 / I-PLG-04）：先校验 `plugin.uninstall`（只有 platform_admin 有；org_admin 等返回 403）；插件不存在 → `404 RUN-7001「插件不存在」`，不写审计；已卸载的插件再卸载返回 200。按安装部门限定卸载范围尚未实现（`plugins` 表目前只有 `created_by`，没有 owner 部门列，待定）。

安装插件（当前实现 `POST /admin/api/plugins/install`，S-29 / I-PLG-01）：先读取并校验整个包的所有字段（顶层 `key`、每个 agent / skill / mcp / provider / model 的 `key`、mcp `url` 与 provider `baseUrl` 的出站静态检查、`env:` 引用），任一不合法 → `400 CFG-8501`，不创建任何资源、不写审计。开始创建后若失败（例如包内同一 provider 下模型 key 重复 → `409 CFG-8503`，或写插件记录失败 → 500），删除本次请求已创建的 agent（含版本）、skill、MCP Server、Provider（含模型），已存在而被跳过的同 key 资源不动；写一条 `plugin.install.failed` 审计（`resource_id` 为空，details：`key`、`error`（错误码，非 ForgeError 记 `internal`）、`compensated`（补偿是否成功）、`rolledBack`（被删除的 id）），再返回原错误。成功时只写 `plugin.install`。

**安装**

```http
POST /admin/v1/installations
```

```json
{
  "packageVersionId": "pv_01J...",
  "scopeType": "org",
  "scopeId": "org_01J...",
  "config": { "erpBaseUrl": "https://erp.acme.internal" },
  "secrets": { "erp_api_key": "sec_01J..." },
  "dryRun": false
}
```

响应：

```json
{
  "installationId": "ins_01J...",
  "status": "installing",
  "steps": [
    { "name": "validate", "status": "succeeded" },
    { "name": "dependencies", "status": "succeeded" },
    { "name": "resources", "status": "running" },
    { "name": "connectivity", "status": "pending" },
    { "name": "activate", "status": "pending" }
  ]
}
```

`dryRun: true` 返回将创建/覆盖的资源、缺失依赖、权限与警告，不落库。

## 5. Skill

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/skills` | 列表 | `skill.view` |
| POST | `/skills` | 新建草稿 | `skill.manage` |
| GET | `/skills/{id}` | 详情与引用方 | `skill.view` |
| PATCH | `/skills/{id}` | 元数据/启停 | `skill.manage` |
| DELETE | `/skills/{id}` | 软删除；被引用需先迁移 | `skill.manage` |
| GET | `/skills/{id}/versions` / `POST` | 版本列表/创建草稿 | `skill.manage` |
| GET | `/skills/{id}/versions/{versionId}` | 内容与资源清单 | `skill.view` |
| PATCH | `/skills/{id}/versions/{versionId}` | 仅草稿 | `skill.manage` |
| POST | `/skills/{id}/versions/{versionId}/publish` | 发布 | `skill.manage` |
| POST | `/skills/validate` | 校验 `SKILL.md` 内容（不保存） | `skill.view` |
| POST | `/skills/{id}/assets` | 上传资源文件 | `skill.manage` |
| DELETE | `/skills/{id}/assets/{assetId}` | 删除资源 | `skill.manage` |
| GET | `/skills/{id}/preview` | 注入上下文预览与 Token 估算 | `skill.view` |
| GET | `/skills/{id}/references` | 引用该 Skill 的 Agent | `skill.view` |

Skill `status`（K-12 / I-SKL-07）：`PATCH /skills/{id}` 的 `status` 只接受 `active`、`disabled`（区分大小写，必须是字符串）；其他值、空串、超过 16 个字符的值一律 `400 CFG-8501`，不写库、不写审计（不会再静默下线，也不会 500）。

校验响应：

```json
{
  "valid": false,
  "issues": [
    { "path": "frontmatter.name", "severity": "error", "message": "name 必须与 Skill Key 一致" }
  ],
  "estimatedTokens": 1240
}
```

## 6. MCP

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/mcp-servers` | 列表与健康状态 | `mcp.view` |
| POST | `/mcp-servers` | 添加（HTTP/stdio） | `mcp.manage` |
| POST | `/mcp-servers/test` | 用未保存配置测试连接 | `mcp.manage` |
| GET | `/mcp-servers/{id}` | 详情 | `mcp.view` |
| PATCH | `/mcp-servers/{id}` | 修改配置 | `mcp.manage` |
| DELETE | `/mcp-servers/{id}` | 删除；被引用时阻止 | `mcp.manage` |
| POST | `/mcp-servers/{id}/test` | 测试已保存配置 | `mcp.manage` |
| POST | `/mcp-servers/{id}/discover-tools` | 刷新工具 | `mcp.manage` |
| GET | `/mcp-servers/{id}/tools` | 工具与风险 | `mcp.view` |
| PATCH | `/mcp-servers/{id}/tools/{toolName}` | 启停/覆盖风险 | `mcp.manage` |
| GET | `/mcp-servers/{id}/health` | 最近检查 | `mcp.view` |
| POST | `/mcp-servers/{id}/restart` | 重启 stdio 进程 | `mcp.manage` |
| GET | `/mcp-servers/{id}/logs` | 最近日志（脱敏、环形缓冲） | `mcp.view` |
| POST | `/mcp-servers/{id}/invoke` | 工具测试台 | `mcp.manage` |
| GET | `/mcp-servers/{id}/references` | 引用方 | `mcp.view` |

添加 stdio 示例：

```json
{
  "key": "erp-mcp",
  "name": "ERP MCP",
  "transport": "stdio",
  "command": ["node", "/opt/forge/mcp/erp/dist/index.js"],
  "env": {
    "ERP_BASE_URL": { "value": "https://erp.internal" },
    "ERP_API_KEY": { "secretId": "sec_01J..." }
  },
  "limits": { "memoryMb": 512, "timeoutMs": 30000 },
  "enabled": true
}
```

## 7. 工具与连接器

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/tool-sources` | 工具源列表 | `tool.view` |
| POST | `/tool-sources/parse` | 解析 OpenAPI，预览操作（不保存） | `tool.manage` |
| POST | `/tool-sources` | 导入并保存（URL/上传/原始文本） | `tool.manage` |
| GET | `/tool-sources/{id}` | 详情 | `tool.view` |
| PATCH | `/tool-sources/{id}` | 修改 Base URL/鉴权/启停 | `tool.manage` |
| DELETE | `/tool-sources/{id}` | 删除；被引用时阻止 | `tool.manage` |
| POST | `/tool-sources/{id}/refresh` | 重新解析（新版本） | `tool.manage` |
| GET | `/tool-sources/{id}/tools` | 工具列表 | `tool.view` |
| PATCH | `/tools/{toolId}` | 描述/风险/启停 | `tool.manage` |
| POST | `/tools/{toolId}/test` | 测试调用 | `tool.manage` |
| GET | `/tool-sources/{id}/references` | 引用方 | `tool.view` |

解析预览：

```json
{
  "info": { "title": "ERP API", "version": "1.4.0" },
  "servers": ["https://erp.internal/api"],
  "operations": [
    { "operationId": "get_contract", "method": "GET", "path": "/contracts/{id}", "risk": "low" },
    { "operationId": "submit_approval", "method": "POST", "path": "/approvals", "risk": "high" }
  ],
  "warnings": ["缺少 securitySchemes，需手工配置鉴权"]
}
```

**Connector 工具源**（公司内部跨系统调用优先使用）：

```json
{
  "key": "pm-project",
  "name": "PM 项目管理",
  "type": "connector",
  "targetSystemId": "<Agent 管理员下发>",
  "operations": [
    {
      "key": "first_reach_time",
      "method": "POST",
      "path": "/service-task/phoenixtask/projectOpen/v1/project/website/serviceFirstReachTime",
      "capability": "project.read",
      "dataScope": "project",
      "risk": "low"
    }
  ]
}
```

- Connector 调用由 SDK 本地策略预检 + Agent Gateway 权威校验；不保存目标系统密钥。
- 出站开关关闭时，测试与运行均失败关闭。
- 目标 System ID、grant、方法/路径必须由 Agent 管理员批准；控制台不能自定义未授权目标。

## 8. 模型

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/llm/providers` | Provider 列表 | `model.view` |
| POST | `/llm/providers` | 添加 Provider（含自定义端点） | `model.manage` |
| POST | `/llm/providers/test` | 测试未保存配置 | `model.manage` |
| GET | `/llm/providers/{id}` | 详情 | `model.view` |
| PATCH | `/llm/providers/{id}` | 修改配置 | `model.manage` |
| DELETE | `/llm/providers/{id}` | 删除；被路由引用时阻止 | `model.manage` |
| POST | `/llm/providers/{id}/discover-models` | 拉取模型列表 | `model.manage` |
| POST | `/llm/providers/{id}/test` | 测试已保存配置 | `model.manage` |
| GET | `/llm/providers/{id}/models` | 模型列表 | `model.view` |
| POST | `/llm/models` | 添加模型 | `model.manage` |
| PATCH | `/llm/models/{id}` | 能力/价格/参数 | `model.manage` |
| DELETE | `/llm/models/{id}` | 删除；被路由引用时阻止 | `model.manage` |
| POST | `/llm/models/{id}/test` | 单模型调用测试 | `model.manage` |
| GET | `/llm/routes` | 路由列表 | `model.view` |
| POST | `/llm/routes` | 创建路由 | `model.manage` |
| PATCH | `/llm/routes/{id}` | 修改候选/条件 | `model.manage` |
| DELETE | `/llm/routes/{id}` | 删除；被 Agent 引用时阻止 | `model.manage` |
| POST | `/llm/routes/{id}/test` | 路由试调用 | `model.manage` |
| GET | `/llm/usage` | 用量聚合（`from`、`to`、`groupBy`） | `usage.view` |
| GET | `/llm/health` | Provider 健康与限流状态 | `model.view` |

自定义 Provider：

```http
POST /admin/v1/llm/providers
```

```json
{
  "key": "acme-llm",
  "name": "Acme 内网模型",
  "protocol": "openai-compatible",
  "baseUrl": "https://llm.acme.internal/v1",
  "auth": { "type": "bearer", "secretId": "sec_01J..." },
  "headers": { "X-Tenant": "acme" },
  "timeoutMs": 120000,
  "tlsVerify": true,
  "enabled": true
}
```

模型：

```json
{
  "providerId": "prv_01J...",
  "key": "acme-chat-32b",
  "displayName": "Acme Chat 32B",
  "capabilities": ["text", "tools", "json_schema", "streaming"],
  "contextWindow": 32768,
  "maxOutputTokens": 4096,
  "pricing": { "inputPerMillionUsd": 0.2, "outputPerMillionUsd": 0.6 }
}
```

路由：

```json
{
  "key": "legal-default",
  "strategy": "ordered",
  "candidates": [
    { "modelId": "mdl_01J...", "params": { "temperature": 0.2 } },
    { "modelId": "mdl_02J...", "conditions": { "fallback": true } }
  ],
  "allowOrgOverride": false
}
```

## 9. 运行与审批

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/runs` | 列表（状态、Agent、应用、用户、`triggerType`、时间） | `run.view` |
| GET | `/runs/{runId}` | 详情 | `run.view` |
| GET | `/runs/{runId}/events` | SSE（会话认证） | `run.view` |
| GET | `/runs/{runId}/messages` | 消息 | `run.view` |
| GET | `/runs/{runId}/tool-calls` | 工具调用明细 | `run.view` |
| GET | `/runs/{runId}/artifacts` | 产物 | `run.view` |
| GET | `/runs/{runId}/usage` | Token 与成本明细 | `run.view` |
| POST | `/runs/{runId}/cancel` | 取消 | `run.cancel` |
| POST | `/runs/{runId}/retry` | 以相同输入创建新 Run | `agent.run` |
| GET | `/approvals` | 待办/历史（风险、Agent、时间） | `approval.view` |
| GET | `/approvals/{approvalId}` | 详情（参数脱敏） | `approval.view` |
| POST | `/approvals/{approvalId}/decide` | 批准/驳回 + 评论 | `approval.decide` |
| POST | `/approvals/{approvalId}/delegate` | 转交（P1） | `approval.decide` |

取消已结束的 Run（当前实现，#79 / I-RUN-06）：`POST /admin/api/runs/{id}/cancel`、`POST /open/v1/runs/{id}/cancel`、`POST /integration/v1/runs/{id}/cancel` 对状态为 `succeeded`、`failed`、`cancelled`、`budget_exhausted` 的 Run 统一返回 `409 RUN-7005「Run 已结束，不能取消」`（`details.status` 为当前状态），状态不变、不写 `run.cancel` 审计。此前三个入口都返回 200（admin 没有专门的码）。

审批：

```http
POST /admin/v1/approvals/apr_01J.../decide
If-Match: "rev-2"
```

```json
{ "decision": "approve", "comment": "金额与合同一致" }
```

- 并发决定返回 `409 APR-2103`；重复决定幂等返回当前结果。
- **审批不存在（包括跨部门访问）统一返回 `404 RUN-7001`**，状态码、错误码、文案完全相同。
- `POST /admin/api/approvals/{id}/decide`（当前实现）：审批不存在、对应 Run 不存在、Run 不在调用者数据范围内，三种情况返回完全相同的 `404 RUN-7001「审批不存在」`（错误码是通用的“资源不存在”码，和其他 404 一样），响应里不出现 Run 的 id 或「Run 不存在」字样。
- 审批对应的 Run 已结束（`succeeded`、`failed`、`cancelled`、`budget_exhausted`，I-APR-38）：在 `decision` 校验之后返回 `409 RUN-7005「Run 已结束，审批不可操作」`，同时把仍为 `pending` 的审批置为 `expired`（现有的审批状态值，不新增 `cancelled`），不写 `approval.decide` 审计、不恢复 Run。此判断只在接口层做，执行循环不变。
- 已经处理过（`approved`/`rejected`/`expired`）的审批再次 decide 返回 `409 CFG-8503「审批已处理或已过期」`（I-APR-37），不论 Run 处于什么状态。
- 错误码优先级（P3-02）：`404 RUN-7001` → `400 CFG-8501`（decision 校验）→ 审批已不是 `pending` 时 `409 CFG-8503` → 审批 `pending` 但 Run 已结束时 `409 RUN-7005`（审批置为 `expired`，因此再次 decide 得到 `CFG-8503`）。
- 超时由工作流处理，API 返回 `APR-2102`。
- 审批参数只在服务端脱敏后展示；不返回秘密。

待审批列表（当前实现）：`GET /admin/api/approvals`，权限 `approval.view`，只返回 `status = pending` 的审批。

- 不带分页参数：响应 `{ items }`，最多 100 条（兼容旧调用方）。
- 带 `page` 或 `pageSize` 任意一个：响应 `{ items, page, pageSize, total }`。`page` 从 1 开始，默认 1；`pageSize` 默认 20，最大 100（超过按 100）；非正整数返回 `400`。
- 数据范围在 SQL 里过滤，和 `GET /runs/{id}` 的可见性一致：`all` 看全部；`org` 只看本部门及下级部门的 Run；`self` 只看 `subject_type = user` 且主体是自己的 Run；应用身份只看本应用的 Run。`total` 是调用者可见的条数，侧栏角标直接用它。
- 排序 `created_at` 倒序，同一时间按 `id` 倒序。
- 每条保留原有字段（`id`、`run_id`、`tool_call_id`、`status`、`risk_level`、`expires_at`、`decided_by`、`decided_at`、`comment`、`created_at`、`agent_name`），新增：
  - `agent_id`；
  - `tool_name`：对应 `tool_calls.tool_key`，找不到工具调用时为 `null`；
  - `args_preview`：服务端生成的参数摘要，形如 `to=a@b.com, subject=周报, api_key=***`，嵌套对象写成 `k={a=1, b=***}`，数组写成 `[x, y]`；没有工具调用时为 `null`；工具参数为空（`{}`）时为空字符串 `""`，前端显示为「无参数」。脱敏规则（任意层级，数组元素同样适用）：
    - **按键名**：把键名按 `_`、`-`、`.`、驼峰、连续大写缩写、字母和数字的边界拆成小写的词，任何一个词等于 `password`、`passwords`、`pwd`、`passwd`、`token`、`tokens`、`secret`、`secrets`、`key`、`keys`、`authorization`、`credential`、`credentials`、`cookie`、`cookies` 时，整个值写成 `***`。例如 `api_key`、`apiKey`、`APIKey`、`X-Api-Key`、`accessToken`、`DB_PWD`、`set_cookies`、`Set-Cookie` 会脱敏，`keyword`、`monkey`、`tokenizer`、`secretary` 不会。**计数字段例外**：拆出的词里同时有 `token`/`tokens` 和 `max`、`min`、`input`、`output`、`prompt`、`completion`、`total`、`num`、`count`、`limit`、`used`、`remaining`、`reasoning`、`cached` 中的任意一个时，视为 token 计数字段，`token`/`tokens` 这个词不算敏感，例如 `max_tokens`、`maxTokens`、`max_output_tokens`、`prompt_tokens`、`total_tokens`、`tokenCount`、`token_limit` 不脱敏；`token`、`tokens`、`access_token`、`refresh_token`、`id_token`、`api_token`、`authToken` 照样脱敏；同一个键里还有别的敏感词时照样脱敏（如 `max_api_key`、`password_count`）。例外只看键名，值本身像密钥（下一条）时仍写成 `***`。运行详情等处的 `maskArgsDeep` 用同一套规则。
    - **按值**：字符串去掉首尾空白后，以 `Bearer `、`Basic `、`sk-`、`ghp_`、`xox` 开头（都不区分大小写，`SK-`、`GHP_`、`BEARER ` 同样命中），或形如 JWT（`^eyJ[\w-]*\.[\w-]*\.[\w-]*$`）时，不论键名是什么都写成 `***`。
    - **URL 和问号**：能被解析的 `http`/`https` 地址里，名为 `token`、`access_token`、`key`、`secret`、`sig`、`signature`（不区分大小写）的参数值写成 `***`，地址其余部分原样保留。其他“像地址”的字符串（含 `://`，或去掉首尾空白后以 `/` 或 `www.` 开头）如果解析不了又含 `?`，第一个 `?` 之后的内容整体写成 `***`，`?` 本身保留，例如 `/cb?token=x` 写成 `/cb?***`、`ftp://h/?k=1` 写成 `ftp://h/?***`。普通文字里的问号不处理，例如 `明天开会?` 原样显示。
    - **JSON 字符串**：去掉首尾空白后以 `{` 或 `[` 开头、并且跳过这个括号和其后的空白后，下一个字符是 `"`、`'`、`{` 或 `[` 的字符串，视为“像 JSON”。像 JSON 且 `JSON.parse` 成功的，先解析，再按上面同样的规则逐层脱敏，按同样格式展示，例如 `body='{"password":"x"}'` 显示为 `body={password=***}`；像 JSON 但解析失败的（比如被截断的 `{ "password":"x"`、`{'token': 'x'`、`[{"k":`），整个值写成 `***`。不像 JSON 的括号开头文字按普通字符串处理，例如 `[草稿] 周报`、`{名字} 你好`、`[1, 2]` 原样显示。
    - 夹在文字里的凭据也会脱敏（只替换值，句子保留）：`password=…`、`token: …`、`api_key=…`、`client_secret=…`、`access_token=…`、`密码：…` 这类“凭据键 + `=`/`:`/`：` + 值”，以及 `Bearer <含数字的串>`、`Basic <base64>`；单独出现的 `sk-…` 密钥（`sk-` 后至少 16 个字母/数字/`_`/`-` 且含数字，整串替换为 `***`；`sk-learn` 这类短词不动，P2）。所以 `#access_token=…`、`ex.com/a?token=…`、全角 `？token=…` 里的值也会变成 `***`。
    - **已知限制**（`tests/args-preview.test.ts` 固定了当前输出）：没有分隔符的说法不识别，例如 `密码是 hunter2`；不含数字的 Bearer 值（`Bearer abc`）不识别；不带协议的地址里非凭据键（如 `?key=…`）原样保留。
    - 脱敏之后，每个值截到 80 字符；整串不超过 300 字符，截断处以 `…` 结尾。键的顺序以数据库 JSON 存储顺序为准。
- 响应里永远不包含原始参数（`args_json`）。

```json
{
  "items": [{ "id": "apr_…", "run_id": "run_…", "tool_call_id": "tcl_…", "status": "pending", "risk_level": "high",
              "expires_at": "…", "decided_by": null, "decided_at": null, "comment": null, "created_at": "…",
              "agent_id": "…", "agent_name": "合同助手", "tool_name": "mail.send", "args_preview": "to=a@b.com, api_key=***" }],
  "page": 1, "pageSize": 20, "total": 37
}
```

运行详情与 Run 响应里的参数脱敏（当前实现，`maskArgsDeep`，`packages/governance/src/mask-args.ts`）：

- 规则和上面 `args_preview` 完全相同（同一个模块 `packages/governance/src/sensitive.ts`）：敏感键名按词匹配、值前缀和 JWT、URL 查询参数、像 JSON 的字符串、解析失败的 JSON 整体打码。区别是：**结构和字段名完全不变**，只把敏感的值换成字符串 `"***"`；不截断；敏感键下的值不论是字符串、对象还是数组都整体换成 `"***"`（`null` 保持 `null`）；像 JSON 的字符串打码后仍是字符串（重新 `JSON.stringify`，没有命中任何规则时原样返回）；循环引用和嵌套超过 32 层的部分整体换成 `"***"`。
- `GET /admin/api/runs/{id}`：
  - `input` 打码。
  - `toolCalls[].args` 和 `toolCalls[].args_json` 打码（两者内容相同）；`result`、`result_json`、`result_text` 原样返回。
  - `messages[]`：`role = user` 的 `content` 整体打码；`role = assistant` 只打码 `content.tool_calls`（其中 `function.arguments` 是 JSON 字符串，打码后仍是字符串）；`tool`、`system` 消息原样返回。
- `GET /admin/api/runs` 列表项、`GET /open/v1/runs/{id}`、`GET /integration/v1/runs/{id}` 的 `input` 同样打码。`output`、`usage`、`/result` 接口和 SSE 事件不变（事件里不带工具参数）。
- 数据库里存的原值不变，执行 Run 时用的仍是原值。
- **已知限制（P1，计划下一轮修）**：工具返回结果不打码——`toolCalls[].result` / `result_json` / `result_text` 和 `role = tool` 的消息原样返回，工具把秘密写进返回值时会出现在运行详情里。

## 10. 定时任务

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/schedules` | 列表（状态、Agent、服务账号、负责人） | `schedule.view` |
| POST | `/schedules` | 创建；默认停用 | `schedule.manage` |
| GET | `/schedules/{id}` | 详情：返回单个对象，字段和序列化与列表项完全一致（含 `agent_name`、`next_run_at`、`last_run_id`、`serviceAccountId`、`failureCount`、`lastErrorCode`） | `schedule.view` |
| PATCH | `/schedules/{id}` | 修改；`If-Match` | `schedule.manage` |
| DELETE | `/schedules/{id}` | 删除；保留历史 Run | `schedule.manage` |
| POST | `/schedules/{id}/enable` / `disable` | 启停 | `schedule.manage` |
| POST | `/schedules/{id}/run` | 立即运行（以服务账号） | `schedule.run` |
| GET | `/schedules/{id}/runs` | 运行历史（分页） | `schedule.view` |
| GET | `/schedules/{id}/next-runs?count=5` | 下次运行预览 | `schedule.view` |

创建示例：

```http
POST /admin/v1/schedules
```

```json
{
  "name": "每周合同审查汇总",
  "agentId": "agt_01J...",
  "serviceAccountId": "svc_01J...",
  "cron": "0 9 * * 1",
  "timezone": "Asia/Shanghai",
  "input": { "text": "汇总上周合同风险" },
  "versionPolicy": "latest_published",
  "concurrencyPolicy": "skip",
  "maxCostUsd": 2,
  "enabled": false
}
```

响应：

```json
{
  "id": "sch_01J...",
  "status": "disabled",
  "nextRunAt": null,
  "revision": 1
}
```

- `versionPolicy`：`latest_published`（默认）或 `pinned` + `agentVersionId`。
- `concurrencyPolicy`：`skip`（默认）、`queue`、`cancel_previous`。
- 服务账号停用、Agent 停用或无权限 → 自动暂停并返回 `SCD-4801` 原因。
- **已知限制（P2，计划下一轮修）**：`GET /schedules`、`GET /schedules/{id}` 返回的 `input_json` 是明文，没有经过 `maskArgsDeep`（审计里的 `schedule.update` 已打码）。
- `cron` 只接受 5 段表达式（分 时 日 月 周）或宏 `@yearly`/`@annually`/`@monthly`/`@weekly`/`@daily`/`@midnight`/`@hourly`（先去掉首尾空白，宏不区分大小写）。宏在创建、PATCH、`/enable` 时换成对应的 5 段表达式再校验并保存（如 `@daily` → `0 0 * * *`）；`@reboot` 和其他宏返回 `400 CFG-8501`，消息「只支持 5 段 cron 或 @yearly/@annually/@monthly/@weekly/@daily/@midnight/@hourly」。普通表达式只去首尾空白。库里已有的宏老数据：PATCH 不带 `cron`/`timezone` 时不重新校验旧值，已知宏顺带改写为 5 段；`/enable` 先归一再校验，5 段结果随启用一起保存；调度器读取时也按同一规则归一。
- 调度器触发时第一步解析 `cron` 和 `timezone`（I-SCH-17 / I-ERR-20）：解析失败（含空串、越界字段、不存在的时区）记 `last_error_code = SCD-4803`、`failure_count + 1` 并停用任务（`status = disabled`、`next_run_at = NULL`），不建 Run；这一步先于 Agent、运行身份等其他检查。
- 触发时运行身份实时校验（S-45，自动触发和手动 run 都一样）：绑定服务账号的，服务账号须为 active，且所属部门及每一级上级部门都启用；未绑定服务账号的存量任务，按任务行上的用户（`subject_type = 'user'` 取 `subject_id`，否则取 `created_by`）做和会话认证相同的校验（用户 active、部门链全部启用）。不满足时：自动触发暂停任务并记 `SCD-4801`；手动 run 返回 `409 SCD-4801`；都不建 Run。
- 校验时查库出错：自动触发只把本次记为失败（`last_error_code = SCD-4803`、`failure_count + 1`），任务保持 active，`next_run_at` 推到下一个 cron 时间；手动 run 返回 `503 SYS-9003`；都不建 Run。
- `run` 创建 Run 后返回 `{ "runId": "run_...", "trigger": "schedule" }`；并发 skip 时返回 409 `SCD-4802`。
- 绑定 platform_admin 服务账号 → 400 SCD-4804；存量任务触发时同码自动暂停。手动 run 先按调用者数据范围查任务，查不到 → 404（platform_admin 除外）。
- `GET /schedules/{id}`：先校验 `schedule.view`（无权限 → 403），再按列表同一数据范围查任务；其他部门的任务与不存在的任务返回完全相同的 404（platform_admin / dataScope all 可读任意部门）。响应不包 `items`，直接是列表里那一项。
- 数据范围（当前实现，列表、`/{id}` 各路由、手动 run、绑定服务账号都一样）：`dataScope = all` 看全部；否则看本部门及其所有下级部门的任务，和 Run 的可见性（`canAccessRun`）一致，父部门能看到、能管理子部门的任务，子部门看不到父部门和平级部门的任务。创建或修改任务时绑定的服务账号也按这个范围查，范围外 → 404「服务账号不存在」。
- Cron/时区由 Temporal 计算；控制台预览不得自行实现调度。
- 所有操作写审计；修改/启停记录前后值。

## 11. 开放平台管理

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api-apps` | 应用列表 | `apikey.view` |
| POST | `/api-apps` | 创建应用 | `apikey.manage` |
| GET | `/api-apps/{appId}` | 详情 | `apikey.view` |
| PATCH | `/api-apps/{appId}` | 修改/启停 | `apikey.manage` |
| DELETE | `/api-apps/{appId}` | 删除；需先吊销密钥 | `apikey.manage` |
| GET | `/api-apps/{appId}/keys` | 密钥列表（仅前缀） | `apikey.view` |
| POST | `/api-apps/{appId}/keys` | 创建密钥（明文仅此次） | `apikey.manage` |
| POST | `/api-apps/{appId}/keys/{keyId}/rotate` | 轮换（可重叠） | `apikey.manage` |
| POST | `/api-apps/{appId}/keys/{keyId}/revoke` | 吊销 | `apikey.manage` |
| GET | `/api-apps/{appId}/quota` / `PUT` | 配额 | `quota.manage` |
| GET | `/api-apps/{appId}/usage` | 用量 | `usage.view` |
| GET | `/api-apps/{appId}/requests` | 调用日志（脱敏） | `usage.view` |
| GET | `/api-apps/{appId}/webhooks` / `POST` | Webhook 列表/创建 | `webhook.manage` |
| GET | `/webhooks/{webhookId}` / `PATCH` / `DELETE` | 管理 | `webhook.manage` |
| POST | `/webhooks/{webhookId}/test` | 发送测试事件 | `webhook.manage` |
| GET | `/webhooks/{webhookId}/deliveries` | 投递记录 | `webhook.manage` |
| POST | `/webhooks/{webhookId}/deliveries/{deliveryId}/replay` | 手动重放 | `webhook.manage` |

创建密钥响应：

```json
{
  "keyId": "key_01J...",
  "name": "生产集成",
  "prefix": "fsk_live_9f2a",
  "key": "fsk_live_9f2a...完整明文仅此一次...",
  "scopes": ["agents:read", "runs:create", "runs:read"],
  "expiresAt": "2027-10-21T00:00:00.000Z",
  "createdAt": "2026-10-21T08:00:00.000Z"
}
```

> 服务端只存哈希；`key` 字段不会再次返回。

应用数据范围固定为 `app`：只能访问本应用创建的 Run/Thread/File/Artifact，Scope 只控制能力，不扩大数据范围；跨应用数据导出需服务账号与审计。

## 12. 组织、角色、功能权限与数据权限

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/org-units` | 组织树 | `org.view` |
| POST | `/org-units` | 新建部门 | `org.manage` |
| PATCH | `/org-units/{id}` | 重命名/移动 | `org.manage` |
| DELETE | `/org-units/{id}` | 删除（需为空） | `org.manage` |
| GET | `/users` | 用户列表（组织、状态、`q`） | `org.view` |
| POST | `/users` | 邀请/创建本地用户 | `org.manage` |
| PATCH | `/users/{id}` | 启停、组织、显示名 | `org.manage` |
| GET | `/groups` / `POST` | 组列表/创建 | `org.view` / `org.manage` |
| PUT | `/groups/{id}/members` | 设置成员 | `org.manage` |
| GET | `/roles` | 角色列表（含内置） | `role.view` |
| GET | `/roles/{id}` | 角色详情、功能权限、数据策略 | `role.view` |
| POST | `/roles` | 创建自定义角色 | `role.manage` |
| PUT | `/roles/{id}/permissions` | 设置权限码 | `role.manage` |
| GET | `/roles/{id}/data-policies` | 数据权限矩阵 | `data_policy.view` |
| DELETE | `/roles/{id}` | 删除自定义角色 | `role.manage` |
| GET | `/role-bindings` / `POST` / `DELETE` | 角色绑定 | `role.manage` |
| GET | `/permissions` | 功能权限目录 | `role.view` |
| GET | `/data-scopes` / `POST` | 数据范围 | `data_policy.view` / `data_policy.manage` |
| PATCH / DELETE | `/data-scopes/{id}` | 修改/删除（被引用时阻止） | `data_policy.manage` |
| PUT | `/roles/{id}/data-policies` | 数据权限矩阵 | `data_policy.manage` |
| GET | `/principal-data-grants` / `POST` / `DELETE` | 例外授权/拒绝 | `data_policy.manage` |
| GET | `/access/preview` | 授权预览（用户/资源/可见范围） | `data_policy.view` |
| GET | `/service-accounts` / `POST` | 服务账号 | `service_account.manage` |
| GET / PATCH | `/service-accounts/{id}` | 详情/修改/停用 | `service_account.manage` |
| PUT | `/service-accounts/{id}/roles` | 服务账号角色与数据范围 | `service_account.manage` |
| GET | `/policies` | 治理策略 | `policy.manage` |
| PATCH | `/policies/{key}` | 风险/审批/预算默认值 | `policy.manage` |

权限码（节选）：

```
agent.view agent.manage agent.publish agent.run
package.view plugin.install plugin.uninstall
skill.view skill.manage mcp.view mcp.manage tool.view tool.manage
model.view model.manage usage.view
run.view run.view.all run.cancel approval.view approval.decide
apikey.view apikey.manage quota.manage webhook.manage
org.view org.manage role.view role.manage policy.manage
data_policy.view data_policy.manage service_account.manage
schedule.view schedule.manage schedule.run
secret.manage audit.view settings.manage sso.manage connector.manage
kb.view kb.manage eval.view eval.manage
```

内置角色：

| 角色 | 说明 |
| --- | --- |
| `platform_admin` | 全部权限；系统设置与安全 |
| `org_admin` | 本组织及子部门的用户、Agent、配额 |
| `builder` | Agent/Skill/MCP/工具/模型配置与发布 |
| `operator` | 运行查看、取消、审批 |
| `auditor` | 审计与用量只读 |
| `user` | 仅使用被授权的 Agent |

用户管理（当前实现）：`GET /admin/api/users` 需 `user.view`，`POST /admin/api/users`、`PATCH /admin/api/users/{id}` 需 `user.manage`（文档上表的 `org.view`/`org.manage` 尚未实现）。用户 `status`（T）：建用户和 PATCH 用户时 `status` 只接受 `active`、`disabled`（代码里没有写入 `deleted` 的路径；登录与会话只认 `active`），其他值返回 `400 CFG-8501`，不写库；建用户不传 `status` 时为 `active`。`GET /admin/api/users`（I-USR-01）只输出白名单字段：`id`、`username`、`email`、`display_name`、`role`、`data_scope`、`org_unit_id`、`status`、`created_at`、`updated_at`（沿用旧控制台在用的 snake_case 命名，不改名）；`idp_subject` 和 `is_emergency_admin`（布尔）只对 platform_admin 输出；`password_hash` 任何角色都不输出。

- 数据范围在 SQL 里过滤：platform_admin 和 `dataScope = all` 看全部用户；`org` 只看本部门及下级部门的用户（`org_unit_id` 为空的用户不可见）；`self` 只看自己。org_admin 不再能看到其他部门的用户。
- `PATCH /users/{id}`：先校验 `user.manage`（无权限 → 403），再按列表同一数据范围查用户；其他部门的用户与不存在的用户返回完全相同的 `404 RUN-7001「用户不存在」`。
- 非 platform_admin 调用时：
  - 目标用户是 platform_admin → `403 POL-2001「不能修改 platform_admin」`（改角色、数据范围、状态都不行）。只有 platform_admin 能修改 platform_admin。
  - 授予 `platform_admin`、`org_admin`，或权限码不是自身权限子集的角色 → `403 POL-2001「不能授予该角色」`。
  - `dataScope` 比自身宽（`self` < `org` < `all`）→ `403 POL-2001「不能授予超出自身的数据范围」`。
  - 不传 `dataScope` 时取角色默认值，但不超过调用者自身的范围（例如 org 范围的 org_admin 授予 `auditor`，默认 `all` 会变成 `org`）。platform_admin 不受此上限影响。
- `dataScope` 只能是 `all`、`org`、`self`，其他值 → `400 CFG-8501`（对所有调用者，包括 platform_admin）；空字符串视为未传。
- `POST /users` 新用户的部门固定为调用者所在部门；`PATCH /users/{id}` 只改 `role`、`dataScope`、`status`。请求体里的 `orgUnitId` 两个接口都忽略，不能把用户移到其他部门。
- 审计：`user.update` 的 details 为 `{ role, dataScope, status? }`（传了 `status` 才记）。

服务账号（当前实现）：`/admin/api/service-accounts` 列表、详情和修改的数据范围和定时任务相同：`dataScope = all` 看全部，否则看本部门及其所有下级部门的服务账号；范围外与不存在都返回 `404「服务账号不存在」`。

## 13. 凭据、审计与设置

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/secrets` | 列表（名称、作用域、引用数，不含值） | `secret.manage` |
| POST | `/secrets` | 新建（只写） | `secret.manage` |
| POST | `/secrets/{id}/rotate` | 轮换 | `secret.manage` |
| DELETE | `/secrets/{id}` | 删除；有引用时阻止 | `secret.manage` |
| GET | `/audit-logs` | 检索（actor、资源、动作、时间） | `audit.view` |
| GET | `/audit-logs/{id}` | 详情（前后值脱敏） | `audit.view` |
| GET | `/audit-logs/export` | 导出 CSV（P1，异步） | `audit.view` |
| GET | `/settings` | 系统设置 | `settings.manage` |
| PATCH | `/settings` | 更新（按 section） | `settings.manage` |
| GET | `/health` | 组件健康 | `settings.manage` |
| GET | `/version` | 版本、迁移版本、构建信息 | 登录用户 |
| GET | `/openapi.json` | 管理 API 规范（管理员） | `settings.manage` |

审计详情脱敏（当前实现）：以下审计在写入前先经过 `maskArgsDeep`（规则见第 9 节），库里 `audit_logs.details_json` 不再出现明文：

- `mcp.update`：改动字段，其中 `headers_json` 的敏感头（如 `Authorization`、`X-Api-Key`）为 `"***"`。
- `schedule.update`：改动字段，其中 `input_json` 按同样规则打码。
- `role_mapping.upsert`：请求体（`agentRoleCode`、`agentRoleName`、`localRole` 原样，敏感字段打码）。

### 13.1 SSO 与 Connector

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/sso/status` | 当前 SSO 模式、issuer、clientId、回调、最近登录、映射数量 | `sso.manage` |
| PATCH | `/sso/config` | 客户自有 OIDC 模式配置；Connector 模式只读 | `sso.manage` |
| POST | `/sso/test` | 测试 issuer/客户端配置（不返回 Token） | `sso.manage` |
| GET | `/sso/role-mappings` / `PUT` | 角色映射；Connector 模式下按签名配置只读 | `sso.manage` |
| GET | `/connector/status` | 在线实例、配置版本、漂移、心跳、开关状态 | `connector.manage` |
| POST | `/connector/refresh` | 触发一次配置刷新（不绕过验签） | `connector.manage` |
| GET | `/connector/audit` | 本地 Connector 事件（脱敏） | `connector.manage` |

- Connector 配置由 Agent 平台签名下发，管理 API 不提供修改签名配置、替换公钥或绕过验签的接口。
- `/integration/v1` 的 Connector 主体（当前实现）：验签通过后按 `subject` 查 `users.idp_subject`。找不到用户、用户 `status` 不是 `active`（停用、已删除）、用户所属部门不存在或它本身或任一上级部门 `status` 不是 `active`，一律返回完全相同的 `403 CON-4706「Connector 主体未在 Forge 登记」`，不区分原因。没有所属部门（`org_unit_id` 为空）的用户不受部门检查影响。
- 生产 SSO 模式切换为 `disabled` 需要平台管理员 + 二次确认；默认禁止。
- 应急管理员与 SSO 状态均写审计。

凭据创建：

```json
{
  "key": "erp_api_key",
  "name": "ERP 生产密钥",
  "scopeType": "org",
  "scopeId": "org_01J...",
  "value": "只写不读的明文"
}
```

响应只返回 `{ "id": "sec_01J...", "key": "erp_api_key", "version": 1 }`。

## 14. P1 资源

| 资源 | 路径 | 说明 |
| --- | --- | --- |
| 知识库 | `/knowledge-bases`、`/knowledge-bases/{id}/documents`、`/knowledge-bases/{id}/search` | CRUD、导入、检索测试 |
| 评测 | `/eval-datasets`、`/eval-runs`、`/eval-runs/{id}/results` | 数据集、批量运行、对比 |
| 通知 | `/notifications`、`/notifications/{id}/read` | 站内通知 |

## 15. 文件与长任务

- 控制台文件上传走 `POST /admin/v1/files`（multipart），返回 `fileId` 与元数据；Agent 试运行引用 `fileId`。
- 安装、导出、评测等长任务返回 `jobId` 或资源状态；通过详情轮询或 SSE 获取进度。
- P1 支持 S3 预签名直传，减少 API 带宽。

## 16. 示例：从零接入自定义模型并发布 Agent

```bash
# 1. 创建 Provider
curl -X POST "$FORGE/admin/v1/llm/providers" \
  -H "Authorization: Bearer $TOKEN" -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"key":"acme-llm","name":"Acme 内网模型","protocol":"openai-compatible","baseUrl":"https://llm.acme.internal/v1","auth":{"type":"bearer","secretId":"sec_01J..."}}'

# 2. 添加模型
curl -X POST "$FORGE/admin/v1/llm/models" \
  -H "Authorization: Bearer $TOKEN" -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"providerId":"prv_01J...","key":"acme-chat-32b","capabilities":["text","tools"],"contextWindow":32768,"maxOutputTokens":4096}'

# 3. 创建路由
curl -X POST "$FORGE/admin/v1/llm/routes" \
  -H "Authorization: Bearer $TOKEN" -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"key":"legal-default","strategy":"ordered","candidates":[{"modelId":"mdl_01J..."}]}'
```

## 17. 契约与测试

- 管理 API 的 DTO 定义在 `packages/contracts`；控制台客户端与测试共用。
- 所有公开接口（含开放平台）由代码生成 OpenAPI 3.1，CI 做 diff；非兼容变更阻止合并。
- 每个写接口至少覆盖：成功、校验失败、无权限、404、并发冲突、审计写入。
- SSE 接口测试续传与权限；文件接口测试大小/类型/越权。
- 管理 API 不作为外部稳定契约，但变更必须同步控制台与文档；开放平台接口遵循独立版本策略。
