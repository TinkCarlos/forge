# Forge 管理 API

版本：1.0　日期：2026-10-21　状态：待评审

> 控制台与自动化工具使用的内部接口。对外集成使用 [open-platform.md](open-platform.md)。本文定义资源面与约定，字段细节以 `packages/contracts` 的 Zod Schema 和生成的 OpenAPI 为准。

## 1. 认证与会话

- Base URL：`https://{forge-host}/admin/v1`
- 控制台使用 **BFF 会话**：浏览器通过统一 SSO（OIDC 授权码 + PKCE）登录，只持有 HttpOnly 会话 Cookie（`Secure`、`SameSite=Lax`），不接触 OIDC Access Token。
- 变更请求必须带 CSRF Token：`X-CSRF-Token`（从 `GET /session` 获取）。
- 自动化/CLI 使用短期 Bearer Token（`Authorization: Bearer ...`），由 `/auth/token` 或在部署配置中签发；不使用用户密码。
- 未认证：`401 AUTH-1001`；已认证但无权限：`403 POL-2001`。
- 所有变更写审计；响应头返回 `X-Request-Id`。
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
| ID | ULID，带资源前缀（`agt_`、`run_`、`pkg_`、`ins_` 等） |
| 时间 | ISO 8601 UTC |
| 分页 | 管理端列表用 `?page=&pageSize=`（`page` 从 1 开始；`pageSize` 默认 20，最大 100）；响应 `{ items, page, pageSize, total }`。`cursor` / `nextCursor` 只用于开放平台接口（见 open-platform.md） |
| 筛选 | `q`、`status`、`orgId`、`type`、`from`、`to`；具体见各资源 |
| 排序 | `sort=field:asc|desc`；仅白名单字段 |
| 乐观并发 | 资源含 `revision`；更新带 `If-Match: "rev-3"`；冲突 `409 CFG-8503` |
| 幂等 | 创建类 `POST` 支持 `Idempotency-Key`，24h；同键异体 `409 OPN-4503` |
| 软删除 | 配置类资源默认软删除；列表不返回；`?includeDeleted=true` 仅管理员 |
| 长任务 | 安装、导出等返回 `jobId`/资源状态；轮询详情或订阅 SSE |
| 错误 | `{ "error": { "code", "message", "requestId", "details", "remedy" } }` |
| 审计 | 所有写操作记录 actor、资源、前后值、IP、UA、traceId |

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

审批：

```http
POST /admin/v1/approvals/apr_01J.../decide
If-Match: "rev-2"
```

```json
{ "decision": "approve", "comment": "金额与合同一致" }
```

- 并发决定返回 `409 APR-2103`；重复决定幂等返回当前结果。
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
  - `args_preview`：服务端生成的参数摘要，形如 `to=a@b.com, subject=周报, api_key=***`，嵌套对象写成 `k={a=1, b=***}`，数组写成 `[x, y]`；没有工具调用时为 `null`。脱敏规则（任意层级，数组元素同样适用）：
    - **按键名**：把键名按 `_`、`-`、`.`、驼峰、连续大写缩写、字母和数字的边界拆成小写的词，任何一个词等于 `password`、`token`、`secret`、`key`、`authorization` 时，整个值写成 `***`。例如 `api_key`、`apiKey`、`APIKey`、`X-Api-Key`、`accessToken` 会脱敏，`keyword`、`monkey`、`tokenizer` 不会。
    - **按值**：字符串去掉首尾空白后，以 `Bearer `、`Basic `（不区分大小写）、`sk-`、`ghp_`、`xox` 开头，或形如 JWT（`^eyJ[\w-]*\.[\w-]*\.[\w-]*$`）时，不论键名是什么都写成 `***`。
    - **URL 查询参数**：`http`/`https` 地址里名为 `token`、`access_token`、`key`、`secret`、`sig`、`signature`（不区分大小写）的参数值写成 `***`，地址其余部分原样保留。
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

## 10. 定时任务

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/schedules` | 列表（状态、Agent、服务账号、负责人） | `schedule.view` |
| POST | `/schedules` | 创建；默认停用 | `schedule.manage` |
| GET | `/schedules/{id}` | 详情、下次运行、最近结果 | `schedule.view` |
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
- `run` 创建 Run 后返回 `{ "runId": "run_...", "trigger": "schedule" }`；并发 skip 时返回 409 `SCD-4802`。
- 绑定 platform_admin 服务账号 → 400 SCD-4804；存量任务触发时同码自动暂停。手动 run 先按调用者数据范围查任务，查不到 → 404（platform_admin 除外）。
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
