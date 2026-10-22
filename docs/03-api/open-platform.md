# Forge 统一开放平台 API

版本：1.0　日期：2026-10-21　状态：待评审

> 面向外部系统的稳定接口。管理端接口见 [admin-api.md](admin-api.md)。所有示例中的密钥、域名、ID 均为占位符。

## 1. 定位

开放平台把已发布 Agent 变成可分发的 API 产品：

```
应用（ApiApp）
  ├─ 密钥（ApiKey）── Scope
  ├─ 配额（Quota）── RPM / 并发 / 周期次数 / 成本
  ├─ Webhook ── 事件签名、重试、重放
  └─ 调用日志 / 用量
        │
        ▼
  /open/v1  ── Run 控制面 + SSE + 文件 + 结果
```

- 只有**已发布、开启 API、且应用有权访问**的 Agent 出现在目录中。
- 默认异步执行；同步便捷调用只是等待结果的语法糖。
- 所有接口以应用为调用主体；终端用户信息只作为业务 `metadata` 传递，不作为平台鉴权依据。
- 应用数据范围固定为 `app`，只能访问自身创建的 Run/Thread/File/Artifact；不接受调用方自报用户身份。
- 管理操作（创建应用、密钥、Webhook）在控制台或管理 API 完成；控制台人类登录走统一 SSO；P1 提供应用自助管理。

## 2. 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | `https://{forge-host}/open/v1` |
| 内容类型 | 请求/响应 `application/json; charset=utf-8`；文件上传 `multipart/form-data` |
| 认证 | `Authorization: Bearer fsk_live_...` |
| ID | ULID 字符串（26 字符）；文件、Run、应用均有前缀便于识别 |
| 时间 | ISO 8601 UTC，毫秒精度，例如 `2026-10-21T08:00:00.000Z` |
| 字段命名 | `camelCase` |
| 未知字段 | 服务端忽略；客户端必须忽略响应中的新增字段 |
| 请求追踪 | 响应头 `X-Request-Id`；错误体同时返回 `requestId` |
| 分页 | 游标：`?cursor=...&limit=20`；响应 `nextCursor`，无更多为 `null` |
| 压缩 | 支持 `Accept-Encoding: gzip`；请求体默认上限 1 MB |
| 超时 | 普通请求 30s；创建 Run 10s；SSE 长连接 |

## 3. 认证与 Scope

### 3.1 API Key

- 格式：`fsk_{env}_{32字节随机}`，例如 `fsk_live_...`；仅创建时展示一次。
- 存储：只存 HMAC-SHA256（服务端 pepper）与可识别前缀；不支持找回。
- 传递：仅 `Authorization` 头；禁止放在 URL 查询参数。
- 生命周期：可设置过期时间；支持多把并存用于轮换；吊销立即生效。
- 每个 Key 绑定一个应用；应用的 Scope、配额、Webhook 对 Key 生效。

### 3.2 Scope

| Scope | 允许 |
| --- | --- |
| `agents:read` | 列出/读取已开放 Agent |
| `runs:create` | 创建 Run、同步调用 |
| `runs:read` | 查询 Run、结果、消息、事件 |
| `runs:cancel` | 取消 Run |
| `runs:message` | 运行中插话（P1） |
| `files:write` | 上传/删除文件 |
| `threads:read` / `threads:write` | Thread API（P1） |

- 缺 Scope → `403` + `POL-2001`，`details.requiredScope` 指明所需 Scope。
- 应用被停用、Key 过期/吊销 → `401`。
- Agent 未开放或未授权给应用 → `404`（不暴露存在性）。

### 3.3 应用数据隔离

- 调用主体是 API 应用；数据范围固定为 `app`。
- 只能读取/取消/下载**本应用创建**的 Run、Thread、File、Artifact；跨应用访问统一 `404`。
- 管理员不能通过 Scope 让应用读取其他应用数据；跨应用数据导出必须走管理端服务账号并审计。
- 开放平台不提供人工登录；人类用户使用控制台 SSO。机器到机器可继续使用 API Key，OAuth2 Client Credentials 为 P1。

## 4. 应用与配额

| 维度 | 默认 | 执行点 |
| --- | --- | --- |
| RPM | 60 | API 网关（Redis 令牌桶） |
| 并发 Run | 5 | 创建 Run 前 |
| 每日 Run 次数 | 1000 | 创建 Run 前 |
| 每月 Run 次数 | 20000 | 创建 Run 前 |
| 每月成本 | $100 | 模型调用前后累计 |
| 单请求体 | 1 MB | 网关 |
| 单文件 | 50 MB | 上传 |
| 单 Run 文件数 | 10 | 创建 Run |
| SSE 连接 | 每 Run 5 | 网关 |

- 配额按应用计；模型 Provider 的并发/TPM 是另一层保护，二者同时生效。
- 超限返回 `429`（瞬时速率）或 `402`/`429`（周期额度，按套餐定义统一用 `429` + code `OPN-4501`），带 `Retry-After`。
- 幂等重放不消耗 Run 次数，但仍计入请求速率。

## 5. 接口目录

| 方法 | 路径 | 说明 | Scope |
| --- | --- | --- | --- |
| GET | `/agents` | Agent 目录 | `agents:read` |
| GET | `/agents/{agentKey}` | Agent 详情与输入/输出 Schema | `agents:read` |
| POST | `/agents/{agentKey}/runs` | 创建异步 Run | `runs:create` |
| POST | `/agents/{agentKey}/invoke` | 创建并等待结果（最长 120s） | `runs:create`, `runs:read` |
| GET | `/runs/{runId}` | 查询 Run | `runs:read` |
| GET | `/runs/{runId}/result` | 获取最终结果 | `runs:read` |
| GET | `/runs/{runId}/messages` | 获取会话消息 | `runs:read` |
| GET | `/runs/{runId}/events` | SSE 事件流 | `runs:read` |
| POST | `/runs/{runId}/cancel` | 取消 Run | `runs:cancel` |
| POST | `/runs/{runId}/messages` | 插话（P1） | `runs:message` |
| POST | `/files` | 上传文件 | `files:write` |
| GET | `/files/{fileId}` | 文件元数据与签名下载地址 | `files:write` |
| DELETE | `/files/{fileId}` | 删除未被引用的文件 | `files:write` |
| GET | `/artifacts/{artifactId}` | Artifact 下载地址 | `runs:read` |
| POST | `/threads` | 创建 Thread（P1） | `threads:write` |
| GET | `/threads/{threadId}` | Thread 详情（P1） | `threads:read` |
| GET | `/threads/{threadId}/messages` | Thread 消息（P1） | `threads:read` |
| GET | `/openapi.json` | OpenAPI 3.1 规范（免认证，不含密钥） | — |

## 6. Agent 目录

### `GET /open/v1/agents`

查询参数：`cursor`、`limit`（1–100，默认 20）、`q`、`category`。

```json
{
  "items": [
    {
      "key": "contract-reviewer",
      "name": "合同审查助手",
      "description": "审查合同条款并输出风险清单",
      "version": "0.1.0",
      "category": "legal",
      "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
      "outputSchema": { "type": "object", "properties": { "risks": { "type": "array" } } },
      "capabilities": ["text", "files", "tools"],
      "estimatedLatency": "30-120s"
    }
  ],
  "nextCursor": null
}
```

### `GET /open/v1/agents/{agentKey}`

返回同结构单对象，额外包含：
- `limits`：最大步数、单次成本上限（对外只读）。
- `files`：支持的输入文件类型与数量。
- `approval`：是否需要人工审批（不暴露内部规则）。

## 7. 创建 Run

### `POST /open/v1/agents/{agentKey}/runs`

请求头：
```
Authorization: Bearer fsk_live_...
Content-Type: application/json
Idempotency-Key: 4b1c6f0e-...
```

请求体：

```json
{
  "input": {
    "text": "审查这份合同，重点看付款与违约条款",
    "files": ["file_01JABCDEF..."],
    "data": { "contractId": "C-1001" }
  },
  "metadata": { "crmId": "CRM-88", "operator": "u-1024" },
  "options": { "maxSteps": 20 }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `input.text` | 条件 | 与 `files`/`data` 至少一项非空；最大 200,000 字符 |
| `input.files` | 否 | 文件 ID 列表，最多 10 个；必须属于同一应用且未过期 |
| `input.data` | 否 | 业务结构化输入，≤64 KB；不得覆盖 Agent 指令 |
| `metadata` | 否 | 键值均为字符串；≤20 键、≤4 KB；用于检索与回传 |
| `options.maxSteps` | 否 | 只能小于等于策略上限；越大无效 |
| `options.timeoutSeconds` | 否 | 只能小于等于策略上限 |
| `threadId` | 否 | P1；传入则续接会话 |

响应 `202 Accepted`：

```json
{
  "runId": "run_01JABCDEF...",
  "agentKey": "contract-reviewer",
  "agentVersion": "0.1.0",
  "status": "queued",
  "createdAt": "2026-10-21T08:00:00.000Z",
  "links": {
    "self": "/open/v1/runs/run_01JABCDEF...",
    "events": "/open/v1/runs/run_01JABCDEF.../events",
    "result": "/open/v1/runs/run_01JABCDEF.../result"
  }
}
```

幂等：
- 同一 `Idempotency-Key` + 相同请求体：返回首次响应（`200`，头 `Idempotency-Replayed: true`）。
- 同 Key 不同请求体：`409` `OPN-4503`。
- 未提供 Key：不去重，调用方自行负责。
- 记录保留 24 小时；5xx 响应不缓存，允许重试。

## 8. 同步便捷调用

### `POST /open/v1/agents/{agentKey}/invoke?wait=60`

- 请求体与创建 Run 相同；`wait` 范围 1–120 秒，默认 30。
- 在等待时间内完成：`200`，返回 Run 结果对象（含 `output`、`usage`、`artifacts`）。
- 超时仍在运行：`202`，返回与创建 Run 相同的响应；调用方继续查询或订阅 SSE。
- 失败/取消/预算耗尽：`200`，返回带 `status` 与 `error` 的结果对象。
- 适用短任务；长任务请使用异步 + Webhook。

## 9. Run 查询与结果

### Run 对象

```json
{
  "runId": "run_01JABCDEF...",
  "agentKey": "contract-reviewer",
  "agentVersion": "0.1.0",
  "status": "running",
  "createdAt": "2026-10-21T08:00:00.000Z",
  "startedAt": "2026-10-21T08:00:01.120Z",
  "completedAt": null,
  "usage": { "inputTokens": 1200, "outputTokens": 340, "costUsd": 0.012 },
  "error": null
}
```

状态：`queued`、`running`、`waiting_approval`、`succeeded`、`failed`、`cancelled`、`budget_exhausted`。

### `GET /open/v1/runs/{runId}/result`

- 非终态：`409` `RUN-7002`，`details.status` 返回当前状态。
- 终态：`200`：

```json
{
  "runId": "run_01JABCDEF...",
  "status": "succeeded",
  "output": { "risks": [] },
  "finalMessage": "已完成审查，共发现 3 项风险。",
  "usage": { "inputTokens": 1200, "outputTokens": 340, "costUsd": 0.012 },
  "artifacts": [
    { "artifactId": "art_01J...", "name": "review.pdf", "mimeType": "application/pdf", "size": 18233 }
  ],
  "completedAt": "2026-10-21T08:00:42.000Z",
  "error": null
}
```

失败示例：

```json
{
  "runId": "run_01JABCDEF...",
  "status": "failed",
  "output": null,
  "finalMessage": null,
  "usage": { "inputTokens": 900, "outputTokens": 120, "costUsd": 0.008 },
  "artifacts": [],
  "completedAt": "2026-10-21T08:00:20.000Z",
  "error": { "code": "MDL-3002", "message": "上下文超出模型上限", "retryable": false }
}
```

### `GET /open/v1/runs/{runId}/messages`

返回面向调用方的消息（系统指令与内部工具原文不返回）：

```json
{
  "items": [
    { "role": "user", "content": [{ "type": "text", "text": "审查这份合同" }], "createdAt": "..." },
    { "role": "assistant", "content": [{ "type": "text", "text": "已完成审查……" }], "createdAt": "..." }
  ],
  "nextCursor": null
}
```

## 10. SSE 事件流

### `GET /open/v1/runs/{runId}/events`

请求头：`Accept: text/event-stream`；断线重连带 `Last-Event-ID`。

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no

id: 1
event: run.queued
data: {"type":"run.queued","seq":1,"runId":"run_01J...","ts":"2026-10-21T08:00:00.000Z","data":{"status":"queued"}}

id: 2
event: run.started
data: {...}

id: 3
event: message.delta
data: {"type":"message.delta","seq":3,"runId":"run_01J...","ts":"...","data":{"messageId":"msg_01J...","delta":"已"}}

id: 9
event: tool.started
data: {"type":"tool.started","seq":9,"runId":"...","data":{"toolCallId":"tc_01J...","tool":"mcp:doc-parser/parse_pdf","risk":"low"}}

id: 15
event: run.completed
data: {"type":"run.completed","seq":15,"runId":"...","data":{"status":"succeeded","usage":{"inputTokens":1200,"outputTokens":340,"costUsd":0.012}}}
```

### 事件类型

| `type` | 时机 | `data` 关键字段 |
| --- | --- | --- |
| `run.queued` | 创建后 | `status` |
| `run.started` | Worker 开始 | `agentVersion` |
| `message.created` | 助手消息开始 | `messageId`, `role` |
| `message.delta` | Token 增量（合并推送） | `messageId`, `delta` |
| `message.completed` | 消息完成 | `messageId`, `content` |
| `tool.started` | 工具开始 | `toolCallId`, `tool`, `risk` |
| `tool.completed` | 工具成功 | `toolCallId`, `durationMs` |
| `tool.failed` | 工具失败 | `toolCallId`, `error` |
| `approval.required` | 等待审批 | `approvalId`, `tool`, `expiresAt` |
| `approval.resolved` | 审批完成 | `approvalId`, `decision` |
| `context.compacted` | 上下文压缩 | `removedMessages`, `summaryTokens` |
| `run.completed` | 成功 | `status`, `usage` |
| `run.failed` | 失败 | `status`, `error` |
| `run.cancelled` | 取消 | `status` |
| `run.budget_exhausted` | 预算耗尽 | `status`, `usage` |
| `heartbeat` | 每 15s | `ts` |

规则：
- `seq` 在同一 Run 内严格递增；`id` 等于 `seq`。
- 事件只保证单 Run 内有序，不保证跨 Run。
- Redis 保留 1 小时热事件；更早的事件从 MySQL 里程碑重建（Token 增量不重建）。
- 重连时若 `Last-Event-ID` 已过期，服务端发送 `event: reset` 与当前快照，客户端应重新拉取 Run/结果。
- SSE 与 Webhook 可同时使用；Webhook 是可靠投递，SSE 是实时体验。
- 每个应用每 Run 最多 5 个并发 SSE 连接。
- 服务端每 15s 发送 `heartbeat`；客户端 45s 无事件应重连。

## 11. 取消与插话

### `POST /open/v1/runs/{runId}/cancel`

- 幂等：已取消/已结束返回当前 Run 对象（`200`）。
- 可取消状态：`queued`、`running`、`waiting_approval`。
- 取消不保证外部副作用回滚；文档明确提示调用方使用幂等写接口。
- 响应 `202` + Run 对象；最终状态以查询为准。

### `POST /open/v1/runs/{runId}/messages`（P1）

```json
{ "text": "补充：重点看第 7 条" }
```
- 仅 `running` 可接受；在下一次模型调用前合入。
- 需要 `Idempotency-Key`；重复提交返回首次结果。
- 非运行状态返回 `409 RUN-7002`。

## 12. 文件与 Artifact

### `POST /open/v1/files`

`multipart/form-data`，字段 `file`；可选 `purpose`（`input`/`attachment`）。

```json
{
  "fileId": "file_01J...",
  "name": "contract.pdf",
  "mimeType": "application/pdf",
  "size": 82213,
  "checksum": "sha256:...",
  "expiresAt": "2026-10-28T08:00:00.000Z"
}
```

- 默认 50 MB；类型按 Agent 输入能力校验；病毒扫描 P1。
- 文件属于应用；只能被同一应用的 Run 引用。
- 未被引用的文件默认 7 天过期；被引用后随 Run 数据保留策略处理。

### `GET /open/v1/files/{fileId}`

返回元数据与 `downloadUrl`（签名，5 分钟有效）。不返回永久公开 URL。

### `DELETE /open/v1/files/{fileId}`

仅未被 Run 引用时允许；已引用返回 `409`。

### `GET /open/v1/artifacts/{artifactId}`

返回元数据与签名下载地址；Artifact 只能由有权读取对应 Run 的应用访问。

## 13. Webhook

### 13.1 配置

在控制台「开放平台 → 应用 → Webhook」或管理 API 配置：

| 字段 | 说明 |
| --- | --- |
| `url` | HTTPS；默认禁止私网（可白名单） |
| `events` | `run.completed`、`run.failed`、`run.cancelled`、`run.budget_exhausted`（P1：`run.waiting_approval`） |
| `secret` | 生成或自定义；只写不读；用于 HMAC |
| `enabled` | 启停 |
| `description` | 备注 |

### 13.2 投递

```
POST https://customer.example.com/hooks/forge
Content-Type: application/json
X-Forge-Event-Id: evt_01J...
X-Forge-Event-Type: run.completed
X-Forge-Delivery-Id: dlv_01J...
X-Forge-Timestamp: 1761033600
X-Forge-Signature: t=1761033600,v1=5f3c...
```

签名算法：
```
signed = `${timestamp}.${rawBody}`
v1 = hex(HMAC_SHA256(webhookSecret, signed))
```
- 校验时间戳窗口 ±5 分钟；常量时间比较。
- 成功：2xx，10 秒内返回；响应体忽略。
- 重试：`1m, 5m, 30m, 2h, 6h`（共 5 次）；4xx（除 408/429）不重试。
- 连续失败 100 次自动停用并通知管理员；保留投递记录 30 天。
- 手动重放：管理 API 按 `deliveryId` 重放；同一 `eventId` 不变，接收方需幂等。
- Secret 轮换（P1）：支持双签名，旧 Secret 保留 7 天。

### 13.3 负载

```json
{
  "id": "evt_01J...",
  "type": "run.completed",
  "version": "1",
  "createdAt": "2026-10-21T08:00:42.000Z",
  "appId": "app_01J...",
  "data": {
    "runId": "run_01J...",
    "agentKey": "contract-reviewer",
    "status": "succeeded",
    "usage": { "inputTokens": 1200, "outputTokens": 340, "costUsd": 0.012 },
    "resultUrl": "/open/v1/runs/run_01J.../result"
  }
}
```

- 默认不内联完整输出（体积与隐私）；需要时调用 `resultUrl`。
- 事件 `version` 独立演进；新增字段是兼容变更。
- 接收方必须按 `id` 幂等。

## 14. 错误模型

```json
{
  "error": {
    "code": "OPN-4501",
    "message": "应用本月运行次数已用完",
    "requestId": "req_01J...",
    "runId": null,
    "details": { "dimension": "monthlyRuns", "resetAt": "2026-11-01T00:00:00.000Z" },
    "remedy": "在控制台调整应用配额，或等待下个周期"
  }
}
```

| HTTP | 场景 | 典型错误码 |
| --- | --- | --- |
| 400 | 参数/JSON Schema 校验失败 | `RUN-7003`、`CFG-8501` |
| 401 | Key 缺失、无效、过期 | `AUTH-1001` |
| 403 | Scope 不足、应用停用 | `POL-2001` |
| 404 | Agent/Run/文件不存在或未开放 | `RUN-7001` |
| 409 | 状态不允许、幂等冲突 | `RUN-7002`、`OPN-4503` |
| 413 | 请求体/文件超限 | `OPN-4504` |
| 415 | Content-Type 不支持 | `OPN-4505` |
| 429 | 限流/配额耗尽 | `OPN-4501`/`OPN-4502` |
| 500 | 内部错误 | `SYS-9001` |
| 502/503 | 上游模型/服务不可用 | `MDL-3001`、`SYS-9003` |

- `retryable` 由错误码决定；`Retry-After` 仅在 429/503 出现。
- 不在错误中返回堆栈、内部地址、密钥或完整上游响应。
- 所有错误写 `api_request_logs` 与审计（按严重度）。

## 15. 限流响应头

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 12
X-RateLimit-Reset: 1761033660
X-Forge-Quota-Limit: 1000
X-Forge-Quota-Remaining: 873
X-Forge-Quota-Reset: 1762070400
```

429 返回 `Retry-After`（秒）与 `details.dimension`。

## 16. 版本与弃用

- 路径主版本：`/open/v1`；兼容变更只新增可选字段/新端点，不改变既有语义。
- 破坏性变更发布 `/open/v2`；v1 至少维护 6 个月，响应头 `Deprecation` 与 `Sunset`。
- 事件与 Webhook 各自带 `version`；按版本维护 Schema。
- OpenAPI diff 进 CI；非兼容变更必须人工审批。
- 每个版本提供变更日志与迁移指南。

## 17. 文档与 SDK

- `GET /open/v1/openapi.json`：OpenAPI 3.1，公开可读，不含示例密钥。
- `/open/docs`：交互式文档（Redoc/Scalar）+ 快速开始 + 错误码 + 事件列表。
- P1 SDK：TypeScript、Python；包含：
  - 带重试与超时的 HTTP 客户端；
  - SSE 解析与 `Last-Event-ID` 续传；
  - Webhook 验签工具；
  - 类型由 OpenAPI 生成。
- 示例（curl）：

```bash
curl -X POST "https://forge.acme.internal/open/v1/agents/contract-reviewer/runs" \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"input":{"text":"审查这份合同"}}'
```

```bash
curl -N "https://forge.acme.internal/open/v1/runs/run_01J.../events" \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H "Accept: text/event-stream"
```

## 18. 安全要求

- 全链路 TLS；HSTS；禁止在 URL 中携带密钥。
- 应用可配置 IP 白名单（P1）；默认仅服务端调用，不开启 CORS。
- 文件类型与大小校验；P1 病毒扫描；下载使用短期签名 URL。
- 日志脱敏：`Authorization`、`apiKey`、Cookie、URL 密钥、文件内容不落日志。
- 调用日志保留 90 天（可配）；Run 数据按客户保留策略。
- 越权访问按资源存在性返回 404，避免枚举。
- 高危工具审批不能被 API 调用方绕过；外部 `options` 只能收紧限制。

## 19. 验收清单

- [ ] 应用/Key/Scope 生效；越权返回 403/404 且不泄露信息。
- [ ] 创建 Run 返回 202；幂等键重放返回原响应；异体 409。
- [ ] SSE 支持续传、心跳、断线重连与过期重置。
- [ ] 同步调用超时返回 202 + runId。
- [ ] 取消幂等；高并发下状态与事件一致。
- [ ] Webhook 签名可验证、重试正确、可重放、失败停用。
- [ ] 配额与限流头正确；429 有 `Retry-After`。
- [ ] 结果、消息、文件、Artifact 只能被同应用访问。
- [ ] OpenAPI 规范与实现契约测试一致。
