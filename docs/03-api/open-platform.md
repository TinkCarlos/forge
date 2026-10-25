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
  /open/v1  ── Run 控制面 + SSE + 文件（未实现） + 结果
```

- 只有**已发布、开启 API、且应用有权访问**的 Agent 出现在目录中。
- 默认异步执行；同步便捷调用只是等待结果的语法糖。
- 所有接口以应用为调用主体；终端用户信息只作为业务 `metadata` 传递，不作为平台鉴权依据。
- 应用数据范围固定为 `app`，只能访问自身创建的 Run/Thread/File/Artifact（File、Artifact 接口未实现）；不接受调用方自报用户身份。
- 管理操作（创建应用、密钥、Webhook）在控制台或管理 API 完成；控制台人类登录走统一 SSO；P1 提供应用自助管理。

## 2. 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | `https://{forge-host}/open/v1` |
| 内容类型 | 请求/响应 `application/json; charset=utf-8`；文件上传 `multipart/form-data`（未实现：`POST /files` 没有注册；现有接口不解析 multipart 字段，创建 Run 按空输入返回 `400 CFG-8501`，见第 7 节） |
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
- 每个 Key 绑定一个应用；应用的配额、Webhook 对 Key 生效。
- Scope：创建 Key 时把应用当时的 `scopes` 记到 Key 上，之后不再改写。每次请求的有效 Scope = Key 的 `scopes` ∩ 应用**当前**的 `scopes`，每次请求都重新读取应用，不缓存：
  - 应用收窄 Scope 后，下一个请求起所有旧 Key 都失去被移除的 Scope（返回 `403 POL-2001`）；
  - 应用放宽 Scope 不会让旧 Key 变宽，要用新增的 Scope 需新建 Key；
  - 交集为空时，所有需要 Scope 的接口都返回 `403 POL-2001`。

### 3.2 Scope

| Scope | 允许 |
| --- | --- |
| `agents:read` | 列出/读取已开放 Agent |
| `runs:create` | 创建 Run、同步调用 |
| `runs:read` | 查询 Run、结果、事件；消息（未实现） |
| `runs:cancel` | 取消 Run |
| `runs:message` | 运行中插话（P1，未实现） |
| `files:write` | 上传/删除文件（未实现） |
| `threads:read` / `threads:write` | Thread API（P1，未实现） |

- 标「未实现」的 Scope 目前没有任何接口使用：应用的 `scopes` 可以写入这些值（只校验是不超过 64 字符、不含 `*` 的字符串），但它们不放行、也不拦截任何请求。在已有 Thread 上续接会话只需 `runs:create`（见第 7 节 `threadId`）。

- 没有通配符：Scope 必须逐条列出。应用的 `scopes` 里任何一项含 `*`（如 `*`、`runs:*`）时，建应用、改应用返回 `400 CFG-8501`（`details.field` 为 `scopes.{序号}`），不保存；升级前库里已存的 `*` 也不当作全开，按普通字符串比对，等于没有这个 Scope。
- 缺 Scope → `403` + `POL-2001`，所需 Scope 写在 `message` 里：`应用缺少 Scope: {scope}`（例如 `应用缺少 Scope: runs:create`）；`details` 为 `null`，不返回 `details.requiredScope`。
- 应用被停用、Key 过期/吊销 → `401`。
- Agent 未开放或未授权给应用 → `404`（不暴露存在性）。

### 3.3 应用数据隔离

- 调用主体是 API 应用；数据范围固定为 `app`。
- 只能读取/取消/下载**本应用创建**的 Run、Thread、File、Artifact（File、Artifact 接口未实现）；跨应用访问统一 `404`。
- 管理员不能通过 Scope 让应用读取其他应用数据；跨应用数据导出必须走管理端服务账号并审计。
- 开放平台不提供人工登录；人类用户使用控制台 SSO。机器到机器可继续使用 API Key，OAuth2 Client Credentials 为 P1。

## 4. 应用与配额

| 维度 | 默认 | 执行点 |
| --- | --- | --- |
| RPM | 60（应用的 `rateLimitPerMinute`，1–100000） | API 进程内，单进程固定一分钟窗口，多实例部署时上限按实例数放大 |
| 并发 Run | 5（未实现） | 创建 Run 前 |
| 每日 Run 次数 | 1000（应用的 `dailyQuota`，1–10000000） | 创建 Run 前；按数据库时区的自然日统计该应用当天建的 Run（不分状态） |
| 每月 Run 次数 | 20000（未实现） | 创建 Run 前 |
| 每月成本 | $100（未实现） | 模型调用前后累计 |
| 单请求体 | 2 MiB | API |
| 单文件 | 50 MB（未实现） | 上传 |
| 单 Run 文件数 | 10（未实现） | 创建 Run |
| SSE 连接 | 每 Run 5（未实现） | 网关 |

- 配额按应用计；模型 Provider 的并发/TPM 是另一层保护，二者同时生效。
- 超限返回 `429`：请求速率超限为 `OPN-4502`，每日 Run 次数用完为 `OPN-4501`。所有 429 都带 `Retry-After`（整数秒）：
  - `OPN-4502`：当前一分钟窗口剩余的秒数，至少 1。
  - `OPN-4501`：按数据库时区距次日 00:00 的秒数（与每日计数同一口径），取值 1–86400；数据库取不到时保守返回 3600。
- 幂等重放（同一应用、同一 `Idempotency-Key`）返回第一次的响应，不消耗 Run 次数；每日次数已用完时重放仍返回原响应，不返回 429。重放仍计入请求速率，超过 RPM 照样返回 `429 OPN-4502`。

## 5. 接口目录

| 方法 | 路径 | 说明 | Scope |
| --- | --- | --- | --- |
| GET | `/agents` | Agent 目录 | `agents:read` |
| GET | `/agents/{agentKey}` | Agent 详情与输入/输出 Schema | `agents:read` |
| POST | `/agents/{agentKey}/runs` | 创建异步 Run | `runs:create` |
| POST | `/agents/{agentKey}/invoke` | 创建并等待结果（最长 120s） | `runs:create` |
| GET | `/runs/{runId}` | 查询 Run | `runs:read` |
| GET | `/runs/{runId}/result` | 获取最终结果 | `runs:read` |
| GET | `/runs/{runId}/messages` | **未实现（请求返回 404）**；获取会话消息 | `runs:read` |
| GET | `/runs/{runId}/events` | SSE 事件流 | `runs:read` |
| POST | `/runs/{runId}/cancel` | 取消 Run | `runs:cancel` |
| POST | `/runs/{runId}/messages` | **未实现（请求返回 404）**；插话（P1） | `runs:message` |
| POST | `/files` | **未实现（请求返回 404）**；上传文件 | `files:write` |
| GET | `/files/{fileId}` | **未实现（请求返回 404）**；文件元数据与签名下载地址 | `files:write` |
| DELETE | `/files/{fileId}` | **未实现（请求返回 404）**；删除未被引用的文件 | `files:write` |
| GET | `/artifacts/{artifactId}` | **未实现（请求返回 404）**；Artifact 下载地址 | `runs:read` |
| POST | `/threads` | **未实现（请求返回 404）**；创建 Thread（P1） | `threads:write` |
| GET | `/threads/{threadId}` | **未实现（请求返回 404）**；Thread 详情（P1） | `threads:read` |
| GET | `/threads/{threadId}/messages` | **未实现（请求返回 404）**；Thread 消息（P1） | `threads:read` |
| GET | `/openapi.json` | OpenAPI 3.1 规范（免认证，不含密钥） | — |

> 标「未实现（请求返回 404）」的路由当前没有注册，请求统一返回 `404 RUN-7001「资源不存在」`（方法不对同样是 404，不返回 405）；第 9、11、12 节的对应小节同样标注。

## 6. Agent 目录

### `GET /open/v1/agents`

查询参数：`cursor`、`limit`（1–100，默认 20）、`q`、`category` 均**未实现**（不分页、不过滤，一次返回该应用可访问的全部已发布 Agent）。

当前每项只返回 `key`、`name`、`description`、`version` 四个字段，响应只有 `items`。下例中的 `category`、`inputSchema`、`outputSchema`、`capabilities`、`estimatedLatency` 字段和 `nextCursor` 均**未实现（响应中不包含）**：

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

返回单个 Agent 对象。当前实现只返回 `key`、`name`、`description`、`version` 四个字段；以下额外字段**未实现（响应中不包含）**：
- `limits`：最大步数、单次成本上限（对外只读）——未实现。
- `files`：支持的输入文件类型与数量——未实现。
- `approval`：是否需要人工审批（不暴露内部规则）——未实现。

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
| `input.files` | 否 | **未实现**：不校验个数、归属和过期，也不读取文件；当作 `input` 里的普通字段原样存进 Run 输入，不返回 400（`input` 对象不限字段）。`input` 没有 `text` 时，用户消息是整个 `input` 的 JSON 文本，文件 ID 会作为文本进入消息。原设计：文件 ID 列表，最多 10 个；必须属于同一应用且未过期 |
| `input.data` | 否 | 业务结构化输入，≤64 KB；不得覆盖 Agent 指令 |
| `metadata` | 否 | 键值均为字符串；≤20 键、≤4 KB；用于检索与回传 |
| `options.maxSteps` | 否 | 只能小于等于策略上限；越大无效 |
| `options.timeoutSeconds` | 否 | 只能小于等于策略上限 |
| `threadId` | 否 | 传入则续接会话（当前已实现）：Thread 必须属于同一个 Agent、由本应用创建，否则 `404 RUN-7001「会话不存在」`，不建 Run；不传则新建 Thread。Thread 的 ID 从创建 Run 响应的 `threadId` 取得（Thread API 未实现） |

顶层 `text`（当前实现，item 9）：可代替 `input` 传纯文本（等同 `input: { text }`）。同时传非空 `text`（trim 后不为空）和不含 `text` 字段的 `input` 对象 → `400 CFG-8501`（`details.field = "text"`），不建 Run；`text` 为 `""` 或纯空白时当作没传，只带 `input` 对象是合法请求（item E 调整，管理端试运行、开放平台、Connector 同改；之前也是 400）（之前用户消息会存成 `[object Object]`）；只传不含 `text` 的 `input` 对象时，用户消息存为该对象的 JSON 文本。管理端试运行与 Connector `/integration/v1/runs` 同一规则。

空输入（当前实现，item E，仅 `/open/v1/agents/{key}/runs`、`/invoke` 与 `/integration/v1/runs`）：`text` 缺省、`null`、`""` 或 trim 后为空算空；`input` 缺省、`null`、`{}`，或只有一个 `text` 键且其值为 `null` / `""` / 纯空白（均含 JSON 文本写法）算空；带了其他键（如 `{ "text": "", "file": … }`）不算空。这两个入口的 `input` 必须是对象（或对象的 JSON 文本）：`[]`、`"[]"` 等数组 → `400 CFG-8501`，不建 Run（之前 202 建 Run）。两边都空 → `400 CFG-8501「缺少字段: text 或 input」`（无 `details`），不建 Run、不写审计、不扣配额；之前这类请求返回 202 并建出 `input = {"text":""}` 的 Run。任一边非空照常建 Run，空的一边当作没传：`text` 有内容配 `input: {}` 等同只传 `text`；空白 `text` 配 `input` 对象按只传 `input` 处理（见上）。`text` / `input` 现在接受 `null`（等同没传，之前是 ajv 400）。`multipart/form-data` 请求的字段不会解析进请求体，所以到这里一律按空输入处理（`/open` 返回上面的 400；`/integration` 先报 `缺少字段: agentKey`）。管理端试运行 `POST /admin/api/agents/{id}/run` 与定时任务立即运行 `POST /admin/api/schedules/{id}/run` 不接入：试运行遇到无 body、`{}`、`text: ""` / 空白、`input: {}` 仍建 Run，`text: null` / `input: null` 仍是 ajv 400；立即运行不读请求体，用定时任务存的 `input`。

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
- Scope 只需 `runs:create`（与创建 Run 相同）：返回的是本次调用刚创建的 Run 的结果，不需要 `runs:read`。之后再用 `/runs/{runId}` 等接口查询或订阅事件才需要 `runs:read`。
- 在等待时间内完成：`200`，返回 Run 结果对象（含 `runId`、`threadId`、`status`、`output`、`usage`、`error`、`completedAt`）；`artifacts` **未实现（响应中不包含）**。
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

### `GET /open/v1/runs/{runId}/messages`（未实现（请求返回 404））

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
event: message.completed
data: {"type":"message.completed","seq":3,"runId":"run_01J...","ts":"...","data":{"text":"已完成，password=***","usage":{...}}}

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
| `message.delta` | 已停用（P1）：不落库、不下发 | — |
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
- 打码（P1）：所有事件的 `data` 与 REST 同等程度打码，用的是 Run 输出的同一个掩码函数（敏感键、`Bearer`/`Basic`/`sk-`/JWT、URL 查询参数、`password=`/`密码：` 这类正文凭据都换成 `***`）。事件写入 `run_events` 时就已打码；读取时（SSE 实时与回放）再过一遍同一函数，修复前写入的旧明文事件因此也是打码后下发（不回填、不改库）。
- `message.delta`（P1 起）：Worker 不再落库、也不再下发；库里修复前留下的 delta 行在读取时过滤掉（不删数据）。客户端以打码后的 `message.completed.data.text` 拿完整消息。
- Redis 保留 1 小时热事件；更早的事件从 MySQL 里程碑重建（Token 增量不重建）。
- 重连时若 `Last-Event-ID` 已过期，服务端发送 `event: reset` 与当前快照，客户端应重新拉取 Run/结果。
- SSE 与 Webhook 可同时使用；Webhook 是可靠投递，SSE 是实时体验。
- 每个应用每 Run 最多 5 个并发 SSE 连接。
- 服务端每 15s 发送 `heartbeat`；客户端 45s 无事件应重连。

## 11. 取消与插话

### `POST /open/v1/runs/{runId}/cancel`

- 已结束（`succeeded`、`failed`、`cancelled`、`budget_exhausted`）：`409 RUN-7005「Run 已结束，不能取消」`，`details.status` 为当前状态；和管理端、Connector 入口一致（#79 / I-RUN-06）。当前实现成功时返回 `200 { "ok": true, "status": "<取消后的实际状态>" }`（`queued`/`waiting_approval` 立即变为 `cancelled`；`running` 在 worker 停下前仍是 `running`），不再返回 `cancelling`。
- 可取消状态：`queued`、`running`、`waiting_approval`。
- 取消不保证外部副作用回滚；文档明确提示调用方使用幂等写接口。
- 成功返回 `200 { ok, status }`（见上）；`running` 的最终状态以查询 Run 为准。
- 不存在或不属于本应用的 Run：`404 RUN-7001「Run 不存在」`，不写审计。

### `POST /open/v1/runs/{runId}/messages`（P1，未实现（请求返回 404））

```json
{ "text": "补充：重点看第 7 条" }
```
- 仅 `running` 可接受；在下一次模型调用前合入。
- 需要 `Idempotency-Key`；重复提交返回首次结果。
- 非运行状态返回 `409 RUN-7002`。

## 12. 文件与 Artifact

### `POST /open/v1/files`（未实现（请求返回 404））

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

### `GET /open/v1/files/{fileId}`（未实现（请求返回 404））

返回元数据与 `downloadUrl`（签名，5 分钟有效）。不返回永久公开 URL。

### `DELETE /open/v1/files/{fileId}`（未实现（请求返回 404））

仅未被 Run 引用时允许；已引用返回 `409`。

### `GET /open/v1/artifacts/{artifactId}`（未实现（请求返回 404））

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
- 打码（P1）：负载入库、发送（签名针对发送出去的打码后正文）和记日志时，都过 Run 输出的同一个掩码函数（`maskArgsDeep`）；修复前已入队的旧负载在发送时打码，不回填。
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
    "message": "应用今日配额已用完",
    "requestId": "req-1a2b",
    "details": null,
    "retryable": false
  }
}
```

上例是每日 Run 次数用完时的实际响应（HTTP 429，响应头带 `Retry-After`，见 §4）。错误体目前只有 `code`、`message`、`requestId`、`details`、`retryable` 五个字段；`runId`、`remedy` 以及 `details.dimension`/`resetAt`、按月次数（`monthlyRuns`）这类维度均**未实现**。

| HTTP | 场景 | 典型错误码 |
| --- | --- | --- |
| 400 | 参数/JSON Schema 校验失败 | `RUN-7003`、`CFG-8501` |
| 401 | Key 缺失、无效、过期；应用停用（`message` 为「应用已停用」） | `AUTH-1001` |
| 403 | Scope 不足 | `POL-2001` |
| 404 | Agent/Run/文件不存在或未开放 | `RUN-7001` |
| 409 | 状态不允许、Run 已结束、幂等冲突 | `RUN-7002`、`RUN-7005`、`OPN-4503` |
| 413 | 请求体/文件超限 | `OPN-4504` |
| 415 | Content-Type 不支持 | `OPN-4505` |
| 429 | 限流/配额耗尽 | `OPN-4501`/`OPN-4502` |
| 500 | 内部错误 | `SYS-9001` |
| 502/503 | 上游模型/服务不可用 | `MDL-3001`、`SYS-9003` |

- 状态码与错误码以代码为准：应用停用返回 `401 AUTH-1001`，不是 `403`；同一请求既缺 Scope、应用又已停用时先报 `403 POL-2001`（Scope 检查在前）。
- `retryable` 由错误码决定；`Retry-After` 目前只在 429 出现（取值见 §4），503 不带。
- 不在错误中返回堆栈、内部地址、密钥或完整上游响应。
- 所有错误写 `api_request_logs` 与审计（按严重度）。

## 15. 限流响应头

以下 `X-RateLimit-*` 与 `X-Forge-Quota-*` 响应头**未实现（响应中不包含）**：

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 12
X-RateLimit-Reset: 1761033660
X-Forge-Quota-Limit: 1000
X-Forge-Quota-Remaining: 873
X-Forge-Quota-Reset: 1762070400
```

目前只有 429 返回 `Retry-After`（整数秒，取值见 §4）；`details.dimension` 未实现。

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
- 文件类型与大小校验；P1 病毒扫描；下载使用短期签名 URL（文件接口未实现）。
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
- [ ] 结果、消息、文件、Artifact 只能被同应用访问（消息、文件、Artifact 接口未实现）。
- [ ] OpenAPI 规范与实现契约测试一致。
