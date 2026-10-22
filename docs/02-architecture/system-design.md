# Forge 总体架构设计（V2）

版本：2.0　日期：2026-10-21　状态：待评审

> 本文取代 [V1 设计](../superpowers/specs/2026-10-21-forge-agent-framework-design.md)。详细契约见：需求 [product-requirements.md](../01-requirements/product-requirements.md)、插件 [plugin-system.md](plugin-system.md)、控制台 [admin-console.md](admin-console.md)、API [open-platform.md](../03-api/open-platform.md)、数据 [mysql-design.md](../04-data/mysql-design.md)。

## 1. 架构目标

1. **一套框架、多客户交付**：客户差异通过能力包、Agent 配置、模型端点、策略表达，不复制框架代码。
2. **内核隔离**：Pi 只出现在适配层；框架对外暴露自己的类型、错误码和扩展接口。
3. **控制面与数据面分离**：控制台/管理 API 管配置；Run 工作流与 Worker 执行；两者通过 MySQL 与事件解耦。
4. **可插拔且有边界**：安装包不能执行任意代码；代码型扩展只允许运维安装的受信包或 MCP 服务。
5. **运行可追溯**：每次 Run 固定 Agent 版本、策略快照、依赖版本、模型路由。
6. **MySQL 单一系统库**：配置、运行、审计、用量全部在 MySQL；Redis 与对象存储都不是事实来源。
7. **统一身份**：所有公司 Forge 项目接入 SSO；生产登录必须经过 OIDC；本地账号只作应急。
8. **双层授权**：功能权限决定能用什么，数据权限决定能看/改哪些行；默认拒绝，deny 优先。

## 2. 技术基线

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 语言/工程 | Node.js 24、TypeScript strict、pnpm workspace、Biome | 全仓统一 |
| Agent 内核 | Pi 1.3.x（`pi-ai`、`pi-mcp`） | 仅 `packages/core/src/pi/` 可 import |
| 工作流 | Temporal TypeScript SDK 1.25+ | 持久化执行、审批、重试、取消、Schedule |
| 接入 | Fastify 5 + SSE | 管理 API、开放 API、集成 API、BFF、静态控制台 |
| 身份 | OIDC 授权码 + PKCE；Agent Connector 0.2.0 | 统一 SSO、Principal 验签、跨系统调用 |
| 系统库 | MySQL 8.0.30+ + Drizzle ORM | 唯一系统数据库；无其他数据库回退 |
| 缓存/事件 | Redis 7 | 限流、SSE Stream、短缓存、会话 |
| 对象存储 | S3 兼容（MinIO/COS/OSS） | 文件、Artifact、包、大工具结果 |
| 前端 | React 19、Vite、Ant Design 5、TanStack Query、Monaco、ECharts | 管理控制台 |
| 文档解析/浏览器 | Python 3.12 + FastMCP（Docling/MinerU）、Playwright MCP | 以 MCP 提供 |
| 观测 | pino、OpenTelemetry、Prometheus、可选 Langfuse | runId 贯穿 |
| 测试 | Vitest、Testcontainers、Temporal Test Server、Playwright、k6 | 真实 MySQL/Redis |
| 交付 | Docker Compose（P0）、Helm（P1） | 私有化/离线 |

## 3. 部署拓扑与进程

```
  浏览器 ──OIDC──▶ IdP / Agent 平台 (Keycloak)
      │                     ▲
      │                     │ 签名配置/心跳/审计
      ▼                     │
  ┌─────────────────────────┴──────────────┐
  │  api (Fastify)                          │
  │  /admin /open /integration /auth /sse   │
  └───────┬──────────┬──────────────┬───────┘
          │          │              │
 外部系统 ─API Key─▶│              │◀─Agent Principal─ Agent 调度系统
          │          │              │
  ┌───────▼──┐   ┌───▼─────────┐   │
  │ MySQL 8  │   │ Redis 7     │   │
  │ 系统+Temporal 库 │ 事件流/限流/会话 │
  └───────┬──┘   └───┬─────────┘   │
          │          │             │
  ┌───────▼──────────▼───────┐     │
  │ Temporal Server          │     │
  └───────┬──────────────────┘     │
          │ task queues            │
  ┌───────▼───────────────────────┐│
  │ workers: llm / http / mcp /   ││
  │ browser / docparse / schedule ││
  └───────┬───────────────────────┘│
          │                        │
  ┌───────▼────────┐      ┌────────▼────────┐
  │ 模型 API        │      │ S3 对象存储      │
  └────────────────┘      └─────────────────┘

Forge 工具 ──AgentConnector.callSystem──▶ Agent Gateway ──▶ 其他业务系统
```

**进程职责**

| 进程 | 职责 | 扩容方式 |
| --- | --- | --- |
| `api` | 鉴权、管理/开放/集成 API、SSE、BFF、静态控制台、启动 Run | 无状态，水平扩 |
| `worker` | Temporal Activity：模型调用、工具执行、MCP、文档解析、Schedule 触发、事件落库 | 按 task queue 分池水平扩 |
| `temporal` | 工作流状态机与任务分发 | HA 部署 |
| `doc-parser` | 文档解析/OCR MCP 服务 | 按 CPU/GPU 扩 |
| `browser` | Playwright MCP 服务 | 严格限并发 |
| `mysql` | 系统库 + Temporal 库（不同 database） | 主从/云 RDS |
| `redis` | SSE Stream、限流、缓存、BFF 会话 | Sentinel/Cluster |
| `minio` | 对象存储 | 分布式/云对象存储 |

P0 单机 Compose 可把 worker 与 api 合并为一个镜像的不同进程；生产建议拆分部署，按队列隔离资源。

## 4. 模块划分

```
apps/
  api/                 Fastify 入口：/admin /open /integration /auth /sse /static
  worker/              Temporal worker 入口，按队列启动
  console/             React 管理控制台
packages/
  core/                类型、错误码、AgentSpec Schema、Principal/AccessContext、Pi 适配层
  contracts/           管理/开放/集成 API 的 Zod DTO、SSE/Webhook 事件 Schema、OpenAPI 源
  store/               Drizzle schema、Repository、迁移、事务
  registry/            能力包、安装生命周期、资源目录、版本解析
  models/              Provider 适配、模型目录、路由、限流、用量与成本
  capabilities/        工具注册表：内置/OpenAPI/MCP/Skill/Connector、执行器、结果处理
  identity/            OIDC/SSO、BFF 会话、用户 JIT、角色映射、Agent Connector、服务账号
  governance/          功能权限、数据权限、策略快照、风险、审批、凭据、审计
  runtime/             Workflow、Activity、Agent 循环、上下文、事件、Schedule
  open-platform/       应用/密钥/Scope/配额/Webhook/公开 API 服务
  eval/                数据集、评测运行器
  sdk/                 TS 客户端 + SSE/验签辅助
  testkit/             Testcontainers、Faux Provider、包 fixtures
services/
  doc-parser/          Python FastMCP：PDF/OCR/Office
  browser/             Playwright MCP
  sandbox/             P2 代码执行隔离
plugins/               内置/示例能力包源码
deploy/                compose、helm、镜像
docs/                  本套契约文档
tests/                e2e、contract、load、fixtures
```

**依赖方向（禁止反向/循环）**

```
core ← contracts ← store ← registry ← capabilities ← runtime ← apps
core ← models ───────────────────────────────↑
core ← identity ─────────────────────────────┤
core ← governance ───────────────────────────┤
core ← open-platform ← apps
core ← eval ← apps
core ← testkit
sdk ← contracts
```

约束：
- `core` 不依赖任何业务包；Pi 只出现在 `core/src/pi/`。
- `identity` 负责认证与 Principal，`governance` 负责授权与审计；二者都只依赖 `core`/`store`，由 `apps/api` 组合，避免循环。
- 所有 SQL 只在 `store`；其他包通过 Repository 接口访问。
- 所有对外 DTO 只在 `contracts`；API、SDK、控制台共用。
- `runtime` 不直接读环境变量；配置由 `apps/*` 注入。
- 包与目录细则见 [repo-layout.md](../05-development/repo-layout.md)。

## 5. 领域模型与配置层级

```
OrgUnit ──< User >── RoleBinding >── Role ──< Permissions
   │                    │                 └──< DataPolicies >── DataScope
   │                    └──< Group
   ├──< ServiceAccount >── RoleBinding
   ├──< ApiApp ──< ApiKey / Quota / Webhook
   ├──< PluginInstallation >── PluginVersion >── PluginPackage
   ├──< Agent ──< AgentVersion >── (Skill / MCP / Tool / ModelRoute refs)
   ├──< Schedule >── ServiceAccount（运行身份）
   └──< Thread ──< Run ──< RunStep / Message / ToolCall / Approval / Artifact
                        └── RunPolicySnapshot（含功能+数据范围）
SSO Provider ──< RoleMapping >── Role
Connector ── Signed Principal / Config / Heartbeat ──> ServiceAccount / User
```

**四层配置**

| 层 | 存储 | 变更方式 | 生效 |
| --- | --- | --- | --- |
| 基础设施 | 环境变量/Secret | 运维 | 进程重启 |
| 系统设置 | `settings` | 控制台 | 热更新 + 缓存失效 |
| 安装实例 | `plugin_installations.config_json` | 控制台 | 热更新，下一次解析生效 |
| Agent 版本 | `agent_versions.spec_json` + 指令 | 草稿/发布 | 新 Run 生效 |
| Run 策略快照 | `run_policy_snapshots` | 启动时冻结 | 运行期不可变 |

作用域解析优先级：`user > role > org > global`；更具体作用域可以停用上级资源，但不能越权扩大。资源可见性 = 已安装启用 ∧ 角色授权 ∧ Agent 绑定。

## 6. 插件化架构（摘要）

Forge 把所有可变能力抽象为**可安装资源**：

| 资源类型 | 形态 | 运行位置 |
| --- | --- | --- |
| Agent Pack | YAML + Prompt + 引用 | 数据库版本记录 |
| Skill | `SKILL.md` + 资源文件 | 上下文注入 |
| MCP | 配置 + 可选 stdio 进程/远程 URL | 独立进程或远程服务 |
| Tool Pack | OpenAPI / Connector 清单 + 策略 | HTTP 执行器 / Agent Connector |
| Provider | 端点 + 模型 + 鉴权配置 | 模型网关 |
| Code Extension | 受信 npm 包（P2） | Worker 进程/沙箱 |

安装、升级、回滚、作用域、热插拔语义、签名与隔离详见 [plugin-system.md](plugin-system.md)。

核心原则：
- **上传包默认不执行代码**。控制台上传的包只能是声明式资源。
- 需要代码的能力以 MCP 服务交付，进程隔离。
- 代码型 Provider/工具适配器只能由运维安装，版本与框架兼容性受检。
- 所有安装写审计；安装失败自动回滚。

## 7. 模型网关

```
AgentVersion.modelPolicy
   └─ Route (条件/顺序)
        ├─ Candidate A: provider + model + params
        ├─ Candidate B: fallback
        └─ ...
ModelGateway
   ├─ capability check（vision/tools/json/context）
   ├─ concurrency + RPM/TPM（Redis 令牌桶）
   ├─ adapter.complete()（Pi 或自定义 OpenAI-compatible）
   ├─ normalize usage/cost
   └─ circuit breaker + fallback
```

- **Provider**：协议、Base URL、鉴权、额外 Header、超时、代理、TLS、凭据引用。
- **Model**：模型 Key、能力、上下文/输出上限、价格、Tokenizer 估算、是否启用。
- **Route**：命名路由，按能力/上下文/组织/预算选择候选，顺序降级，熔断冷却。
- **Run 固定 Route 快照**：运行中改路由不影响当前 Run；重试使用同一快照。
- **成本**：每次调用写 `llm_usage_events`；未知价格按 0 计但告警；预算检查在调用前后各一次。
- **能力不匹配**：启动 Run 前预检（例如要求视觉但模型无 vision）；运行中拒绝并返回 `MDL` 错误，不静默丢弃。

自定义模型两条路径：
1. **配置型（P0，推荐）**：OpenAI-compatible / Anthropic-compatible 端点，控制台添加即可。
2. **代码型（P2）**：非标准协议，由运维安装受信适配器，控制台不放上传入口。

## 8. 运行时：Temporal 工作流

### 8.1 启动

1. 主体认证：控制台用户 JWT/会话，或开放平台 API Key。
2. 解析 Agent 已发布版本、安装作用域、角色权限。
3. 生成 **RunPolicySnapshot**：可用工具/技能/MCP、模型路由、预算、审批规则、数据边界。
4. 写 `runs`（`queued`）+ `run_policy_snapshots` + 启动 `AgentRunWorkflow`（WorkflowId = `run-{runId}`）。
5. API 返回 `runId`；客户端订阅 SSE。

### 8.2 状态机

```
queued ──▶ running ──▶ succeeded
   │          │  ├──▶ failed
   │          │  ├──▶ cancelled
   │          │  ├──▶ budget_exhausted
   │          │  └──▶ waiting_approval ──▶ running
   └──────────┴──▶ cancelled（排队中取消）
```

### 8.3 Activity 划分

| Activity | 队列 | 职责 | 幂等/重试 |
| --- | --- | --- | --- |
| `prepareContext` | `main` | 读 Thread、拼 Skill 目录、裁剪/压缩、写 context 引用 | 读操作可重试 |
| `callModel` | `llm` | 拼请求、流式 Token、落消息、返回工具调用/用量 | 由模型网关处理重试与降级 |
| `executeTool` | `http` / `mcp` / `docparse` / `browser` | 治理校验、秘密注入、执行、审计、结果落库 | `runId:toolCallId` |
| `requestApproval` | `main` | 创建审批记录、推送事件（等待在 Workflow 内） | 幂等 |
| `compactContext` | `llm` | 摘要旧消息、保留系统指令与最近轮次 | 可重试 |
| `validateOutput` | `main` | JSON Schema 校验与修复提示 | 纯计算 |
| `finalizeRun` | `main` | 写最终状态、用量、事件、通知 | 幂等 |
| `emitEvent` | `main` | 写 `run_events` + Redis Stream | 事件 ID 幂等 |

**关键约束**
- 上下文正文不进 Temporal 历史，只传 `runId`/`stepId`/对象存储 key/摘要。
- 每个 Activity 有超时与心跳；长任务按类型配置。
- 并行工具在 Workflow 内用 Futures 并发，受限并发数；批准工具按顺序审批。
- 用户插话通过 `user_message` Signal，在下一轮模型调用前合入。
- 取消通过 `cancel_requested` Signal + `CancellationScope`；状态与事件必须一致。
- 审批通过 `condition` + Timer 等待；超时按策略驳回。

### 8.4 一次运行的详细数据流

1. `prepareContext`：读取 Thread 历史、Agent 指令、Skill 目录、可用工具摘要；超阈值压缩；写 `run_steps`。
2. `callModel`：模型网关选路由、限流、流式输出；Token 增量写 Redis Stream；完成后写 `messages` 与 `llm_usage_events`。
3. 预算检查：累计步数、Token、成本；超限 → `budget_exhausted`。
4. 工具决策：无工具调用 → 输出校验 → 结束；有工具调用 → 逐个/并行治理。
5. 工具治理：策略快照允许 → 风险分级 → 高危审批 → 执行时取秘密 → 执行 → 结果脱敏/截断 → 审计。
6. 工具结果回填上下文，进入下一轮；达到最大步数 → 失败/部分输出。
7. 输出：结构化校验，不合格带错误反馈模型至多 N 次；通过后落 `runs.output_json`。
8. 结束：`finalizeRun` 写状态、用量、事件、通知，触发 Webhook。

### 8.5 事件与流式

- 事件 Schema 在 `packages/contracts`，带 `seq`、`type`、`version`、`runId`、`ts`。
- 里程碑事件写 MySQL `run_events`；Token 增量只进 Redis Stream（可配置采样落库），最终消息落库。
- SSE 读取 Redis Stream，支持 `Last-Event-ID`；Redis 过期后回放 DB 里程碑 + 最终消息。
- 多 API 实例通过 Redis Stream 共享，不依赖粘性会话。

### 8.6 定时任务

- 使用 **Temporal Schedule**，不自研定时器；每个 `schedules` 记录对应一个 Temporal Schedule。
- 触发时以 **服务账号** 身份创建 Run：`trigger_type=schedule`、`trigger_ref=scheduleId`；使用服务账号的角色与数据范围生成策略快照。
- 配置项：Cron/时区、输入模板、启停、版本策略（触发时已发布 / 固定版本）、并发策略（`skip`/`queue`/`cancel_previous`，默认 `skip`）、失败通知。
- 下次运行时间由 Temporal 计算并同步到 `schedules.next_run_at`；控制台展示未来 5 次运行。
- 补跑/回填（P1）：按时间窗手动触发，受并发、预算与幂等保护；不自动补跑错过的调度。
- 服务账号停用、Agent 停用或无权限 → Schedule 自动暂停并记录原因；恢复需人工确认。
- 定时任务的每次 Run 与手动 Run 使用同一工作流、审批、预算与审计路径；不绕过治理。
- 控制台页面与接口见 [admin-console.md](admin-console.md)、[admin-api.md](../03-api/admin-api.md)。

### 8.7 过渡调度：MySQL 租约（Temporal 之前）

8.1–8.6 仍是目标编排。Temporal 接入前，worker 用 MySQL 租约驱动同一套步骤，之后只替换调度器，不重写循环。

- `runs.claimed_by`、`lease_expires_at`、`heartbeat_at` 只服务当前队列。`waiting_approval` 释放租约；租约过期的 `running` 可被其他 worker 认领。
- 每步写入 `run_steps`（`prepare_context` / `compress` / `call_model` / `execute_tool` / `validate_output`）。已落库的 assistant 消息和 `succeeded` 工具调用不重做。
- 未落库的模型调用至少再执行一次，并写事件 `model.retried`。工具幂等键为 `runId:toolCallId`（`tool_calls.idempotency_key`）。
- 低/中风险工具按 `limits.maxParallelTools` 并行；高风险工具仍串行审批。执行前再次确认工具仍在该 Run 的工具快照内。
- 上下文超过 `limits.maxContextTokens` 时裁剪旧工具/助手正文，保留 system 与最近消息，事件 `context.compressed`。正文仍在 MySQL，不进调度历史。
- 模型流式增量写入 `run_events.message.delta`。SSE 继续按 `Last-Event-ID` 从 MySQL 续传。Redis Stream 仍是多实例目标形态。
- 主模型遇到可重试错误（429/5xx/超时）按 `MODEL_MAX_ATTEMPTS` 重试，然后使用 `model.fallbackProvider` / `model.fallbackModel`。
- 结构化输出校验失败时，把错误喂回模型，最多 `limits.maxOutputRetries` 次，最终失败码 `OUT-6001`。
- 单进程同时执行的 Run 数由 `MAX_CONCURRENT_RUNS` 限制，默认 2。

## 9. 治理与安全

### 9.1 身份与授权

| 主体 | 认证 | 授权 |
| --- | --- | --- |
| 控制台用户 | OIDC SSO 授权码 + PKCE + BFF HttpOnly 会话 + CSRF | 功能权限 + 数据权限 |
| Agent 平台入站 | Connector 签名 Principal（`/integration/v1`） | Principal 策略 ∩ 本地权限 |
| 开放平台调用 | API Key（HMAC-SHA256 哈希存储） | Scope + 应用配额 + `app` 数据范围 |
| 服务账号 | 内部签发/绑定，不可登录控制台 | 角色 + 数据策略；定时任务/集成 |
| 内部服务 | 网络隔离 + 服务令牌（短期） | 固定内部权限 |
| 应急管理员 | 本地账号 + 强密码 + 一次性登录 | 仅管理面，强制审计 |

- 公司部署生产 SSO 必须 `required`；OIDC 配置与角色映射见 [sso-and-connector.md](sso-and-connector.md)。
- 权限码集中定义，默认拒绝；控制台按权限渲染。
- 角色可绑定到全局/组织/组/用户；组织树用 materialized path。
- API Key 只在创建时显示明文，之后只显示前缀。

### 9.2 策略快照

包含：`subject`（用户/服务账号/应用）、角色、功能权限版本、允许的 Agent/工具/MCP/Skill、模型路由白名单、预算、审批规则、**数据范围与数据策略版本**、风险规则版本。快照写库并对 Run 不可变；高风险工具执行前实时复核凭据作用域与主体状态（防撤权后继续执行）。

### 9.3 凭据

- 信封加密：主密钥（环境变量/KMS）→ 每凭据 DEK → AES-256-GCM；数据库只存密文与 key version。
- 只在 Activity 执行时解密注入 HTTP Header/环境变量；不进入 Prompt、Temporal 历史、日志。
- 轮换：新增版本，旧版本保留解密能力；引用计数；删除前检查引用。
- 日志统一脱敏 `Authorization`、`apiKey`、`token`、`password`、Cookie、URL 查询密钥。

### 9.4 风险与审批

- 风险级别：`low`、`medium`、`high`、`critical`。
- 来源：工具注解、HTTP 方法/路径、MCP 工具注解、自定义规则；管理员可覆盖。
- `high` 默认审批；`critical` 默认审批 + 组织管理员；策略可调。
- 审批超时、驳回、取消都有明确事件；执行前再次校验。

### 9.5 外部输入与 SSRF

- OpenAPI/MCP/Web 抓取默认拒绝私网、链路本地、云元数据地址；白名单可配。
- 重定向最多 3 次且每跳重新校验；禁止 `file://` 等协议。
- DNS 解析后校验 IP；防 DNS 重绑定；限制响应大小与超时。
- 工具输出视为不可信内容，不直接作为系统指令；高危工具不看模型自由文本决定权限。

### 9.6 包与供应链

- 校验 checksum、manifest、路径穿越、压缩炸弹、文件数/大小。
- P0 允许管理员安装未签名包但显式告警；P1 引入 minisign 信任库。
- 控制台上传包不执行代码；MCP stdio 命令受白名单与运行用户限制。
- 代码型扩展只允许运维安装；镜像固定 digest；依赖锁定。

### 9.7 沙箱

Pi 内置 bash/文件工具在服务端禁用。文档解析与浏览器在独立服务。代码执行 P2 才引入独立沙箱（容器 + 无网络/只读 FS + 资源限制），不与 Worker 共享进程。

### 9.8 功能权限与数据权限

- **功能权限**：权限码 → 角色 → 用户/组绑定；菜单、操作、API 一致；默认拒绝。
- **数据权限**：资源 × 动作 × 范围（`all/org_tree/org/custom_orgs/self/app/service_account`）；deny 优先；与外部 Principal 范围取交集。
- **运行时强制**：Repository 接收统一 `QueryFilter`；列表/详情/导出/下载/SSE/知识库检索都必须过滤；禁止先全量再内存过滤。
- **服务账号**：定时任务与系统集成使用，独立角色与数据范围，不可登录控制台。
- **授权预览**：按用户/资源展示有效权限、可见记录与拒绝原因。
- 详细设计见 [permissions.md](permissions.md)，表结构见 [mysql-design.md](../04-data/mysql-design.md)。

### 9.9 统一登录与 Agent Connector

- **SSO**：OIDC 授权码 + PKCE；BFF 会话；JIT 用户；角色映射；生产 `required`；本地应急管理员仅故障使用。
- **Connector**：签名配置 + LKG + 心跳；入站 Principal 验签、身份头清理、路径规范化、硬拒绝；出站 `callSystem`，不保存目标密钥。
- **专用集成 API**：仅 `/integration/v1` 暴露给 Agent 平台；`/admin`、`/open`、凭据路径硬拒绝。
- **发布**：首次部署开关关闭，验收后灰度；撤销/签名失败失败关闭。
- 详细设计见 [sso-and-connector.md](sso-and-connector.md)。

## 10. 管理控制台（摘要）

控制台是配置与运营中心，不是最终用户业务前端。信息架构：

```
总览
构建：Agents / Skills / MCP / 工具与连接器 / 模型 / 知识库(P1)
运行：运行中心 / 审批中心 / 定时任务 / 评测(P1)
开放平台：应用与密钥 / 用量与配额 / Webhook / API 文档
治理：组织与成员 / 角色与功能权限 / 数据范围与数据策略 / 服务账号 / 审计 / 凭据
设置：SSO 与 Connector / 系统 / 通知 / 保留策略 / 关于
```

- React 19 + Ant Design 5 + TanStack Query；JSON Schema 表单；Monaco 编辑器；ECharts。
- BFF 模式：OIDC 会话 Cookie；管理 API 同源；变更请求带 CSRF Token。
- 所有资源页支持：列表/搜索/分页、空态、加载、错误、权限态、审计入口。
- 安装向导统一：校验 → 配置 → 依赖 → 作用域 → 安装 → 试运行 → 发布。
- 定时任务页：Cron/时区、启停、立即运行、下次运行、历史、失败原因。
- 权限页：功能权限矩阵、数据权限矩阵、授权预览、服务账号。
- 页面、流程、组件与验收详见 [admin-console.md](admin-console.md)。

## 11. 统一开放平台（摘要）

```
外部应用 ──API Key──▶ 开放网关（Fastify）
                        ├─ Scope / 配额 / 限流 / 幂等
                        ├─ Run 控制面（创建/查询/取消/结果/文件）
                        ├─ SSE 事件
                        └─ Webhook 投递器
                              └─ 签名 + 重试 + 死信 + 重放
```

- 只暴露已发布且开启 API 的 Agent；API 目录含输入/输出 Schema。
- 默认异步：`POST /open/v1/agents/{agentKey}/runs` 返回 202；`GET /runs/{id}` 查询；SSE 订阅事件。
- 同步便捷调用：`invoke?wait=60`，超时仍返回 202。
- 应用维度配额：RPM、并发 Run、周期次数/成本；429 带标准限流头。
- 应用数据隔离：只能读取自身创建的 Run/Thread/File/Artifact；跨应用 404。
- Webhook 使用 HMAC-SHA256 签名、指数退避重试、投递记录与手动重放。
- 公开接口自动生成 OpenAPI 3.1，控制台内置文档门户。
- 接口、事件、错误、配额详见 [open-platform.md](../03-api/open-platform.md)。

## 12. 数据与存储

| 存储 | 事实来源 | 内容 | 说明 |
| --- | --- | --- | --- |
| MySQL | 是 | 配置、版本、Run、消息、工具调用、审批、审计、用量、应用密钥、SSO 映射、数据策略、定时任务 | 唯一系统库；Temporal 用独立 database |
| Redis | 否 | SSE Stream、限流计数、短缓存、BFF 会话、锁 | 丢失可恢复/可重建 |
| S3 | 文件正文 | 上传文件、Artifact、能力包、大工具结果、知识库原文 | 数据库存 key/checksum |
| Temporal | 工作流状态 | 工作流历史、Schedule | 不存大上下文；独立库 |
| Langfuse（可选） | 否 | LLM Trace 可视化 | 故障不影响主流程 |

- 所有主键 ULID（`CHAR(26) ascii_bin`）；时间 UTC `DATETIME(3)`。
- 配置表软删除/状态停用；日志与事件追加写，按月分区并设置保留期。
- 迁移 forward-only，采用 expand/contract；生产禁止 `drizzle-kit push`。
- 表、索引、分区、保留、备份详见 [mysql-design.md](../04-data/mysql-design.md)。

## 13. 可观测性

- **日志**：pino JSON；固定字段 `code/message/runId/workflowId/activity/toolName/traceId/userId/orgId/durationMs`；每个错误只在边界记录一次。
- **Trace**：OpenTelemetry；Span：`run`、`model.call`、`tool.call`、`mcp.discover`、`activity`、`webhook.deliver`。
- **指标**：Run 状态计数、队列积压、模型延迟/错误/限流、工具延迟/错误、审批等待时长、Webhook 成功率、DB/Redis 健康。
- **审计**：与日志分离，写 `audit_logs`，供合规查询与导出。
- **用量**：`llm_usage_events` + `usage_daily`；控制台展示成本与配额。
- **可选 Langfuse**：只发送脱敏后的模型输入/输出，按客户合规开关。

## 14. 错误处理

### 14.1 错误码分域

| 号段 | 域 | 示例 |
| --- | --- | --- |
| `AUTH-1xxx` / `SSO-12xx` | 认证/会话/SSO | `AUTH-1001` 令牌缺失或过期；`SSO-1201` 登录被拒 |
| `POL-2xxx` / `APR-21xx` | 权限/审批 | `POL-2001` 无权使用工具；`APR-2102` 审批超时 |
| `MDL-3xxx` | 模型 | `MDL-3001` 限流可重试；`MDL-3002` 上下文超长 |
| `HTP-40xx` / `MCP-41xx` | HTTP 工具/MCP | `HTP-4001` 业务错误；`HTP-4002` 5xx 重试 |
| `BRW-42xx` / `DOC-43xx` | 浏览器/文档 | `DOC-4302` OCR 失败 |
| `OPN-45xx` / `WHK-46xx` | 开放平台/Webhook | `OPN-4501` 配额耗尽；`WHK-4601` 验签失败 |
| `CON-47xx` / `SCD-48xx` | Connector/定时任务 | `CON-4701` Principal 验签失败；`SCD-4801` 服务账号停用；`SCD-4803` 触发时出现未分类异常；SCD-4804 服务账号角色不允许（platform_admin 不可绑定定时任务） |
| `BUD-5xxx` / `OUT-6xxx` | 预算/输出 | `BUD-5001` 成本耗尽 |
| `RUN-7xxx` | 运行 | `RUN-7001` Run 不存在；`RUN-7002` 状态不允许 |
| `PKG-8xxx` / `CFG-85xx` | 包/配置 | `PKG-8001` manifest 非法；`CFG-8501` 配置缺失 |
| `SYS-9xxx` | 基础设施 | `SYS-9002` 凭据读取失败 |

- 错误码只定义在 `packages/core/src/errors/codes.ts`，含 `code/meaning/userMessage/remedy/httpStatus/retryable/audience`。
- 代码只能抛 `ForgeError`；字面量联合类型保证不存在的码编译失败。
- `docs/reference/error-codes.md` 自动生成；CI 校验重复、缺失、文档同步。

### 14.2 失败语义

| 场景 | 处理 |
| --- | --- |
| 模型限流/5xx | 指数退避重试 → 切备用模型 → 失败交还 Run |
| 上下文超长 | 先压缩再重试一次；仍超长失败 `MDL-3002` |
| 工具 4xx 业务错误 | 不重试，作为工具结果交还模型 |
| 工具 5xx/超时 | 重试（幂等键保护）；用尽后作为工具错误交还模型 |
| Worker 崩溃 | 目标：Temporal 重放，已完成 Activity 不重做。过渡实现见 8.7：租约过期后重领，已落库步骤不重做 |
| 审批超时 | 按策略驳回，Run 继续或失败（Agent 配置） |
| 取消 | 取消 Activity；保留部分消息；事件与状态一致 |
| Webhook 失败 | 指数退避重试；超限停用 + 告警；可手动重放 |

## 15. 并发与限流

- **Temporal 队列**：`llm`（高并发）、`http`、`mcp`、`docparse`、`browser`（严格）、`main`、`maintenance`。
- **模型**：Provider 级并发/RPM/TPM；组织/应用级配额；Redis 令牌桶；超限排队或快速失败。
- **用户**：默认同时 3 个 Run，超出排队；可配。
- **应用**：并发 Run、RPM、周期次数/成本。
- **工具**：按类型并发上限；浏览器与文档解析独立 Worker 池。
- **公平性**：队列按主体权重；防止单用户/单应用占满。
- **背压**：API 在队列过载时返回 429/503 + `Retry-After`，不无限堆积。

## 16. 测试策略

| 层 | 内容 | 工具 |
| --- | --- | --- |
| 单元 | 权限、Spec 校验、错误码、路由选择、成本计算、包校验 | Vitest |
| 集成 | Repository + 真实 MySQL/Redis；迁移；分区；事务 | Testcontainers |
| 工作流 | 审批超时、取消、重试、预算、崩溃恢复、并行工具 | Temporal Test Server |
| Agent 循环 | Faux Provider 确定性多步工具调用 | Pi Faux / testkit |
| 契约 | 管理/开放 API、SSE/Webhook 事件、OpenAPI diff | Schemathesis/自定义 |
| 插件 | fixtures：合法/非法包、依赖冲突、升级/回滚/卸载保护 | testkit |
| SSO/Connector | OIDC 登录、角色映射、Principal 验签、身份头清理、硬拒绝、配置刷新/撤销 | Mock IdP + contract vectors |
| 权限 | 功能权限矩阵、数据范围、deny、跨组织、导出/下载/SSE、预览 | Vitest + Testcontainers |
| 定时任务 | Schedule 触发、并发策略、服务账号、时区/DST、停用暂停 | Temporal Test Server |
| 控制台 | 关键流程 E2E、权限态、空/错态 | Playwright |
| 负载 | 50 并发用户、200 Run/h、SSE 连接 | k6 |
| 安全 | 越权、SSRF、密钥泄漏、包路径穿越、提示词注入基线 | 单测 + 扫描 |
| 黄金场景 | 每晚真实模型跑示例 Agent | eval |

**CI 门禁**：lint + typecheck + unit + integration + contract + migration from empty + build；夜间 e2e、load、golden eval。

## 17. 部署与交付

- **P0**：Docker Compose 单机；镜像固定 digest；迁移 Job；备份/恢复脚本；健康检查；`.env.example`。
- **P1**：Helm、HA、离线包、Prometheus/Grafana、告警规则。
- **升级**：先迁移（向后兼容）→ 滚动 API → 滚动 Worker（Temporal Worker Versioning）→ 验证；插件单独升级，可回滚。
- **备份**：MySQL 每日全量 + binlog；对象存储同步；配置导出；定期恢复演练。
- **发布**：遵循公司 K8s/CI/Nginx 上游文档与 [release-process.md](../06-operations/release-process.md)；迁移先行、镜像 digest、SSO/Connector 开关默认关闭、灰度与回滚留档。
- 详见 [deployment.md](../06-operations/deployment.md)。

## 18. 已知风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| Pi 版本迭代快 | 升级破坏 | 适配层隔离、锁版本、回归测试、禁止业务直接 import |
| Temporal 运维复杂 | 交付成本 | Compose 一键包、运维文档、健康检查、P1 Helm |
| 自定义模型兼容差异 | 工具/多模态行为不一致 | 能力声明 + 预检 + 契约测试包；明确不支持项 |
| 插件安全 | 供应链/越权 | 声明式包、签名、权限审查、MCP 隔离、禁止任意代码 |
| 上下文与成本失控 | 费用/延迟 | 预算快照、压缩、最大步数、成本仪表盘、硬停止 |
| MySQL 日志膨胀 | 性能/备份 | 分区、保留策略、归档、索引审查 |
| Webhook 不可靠 | 集成失败 | 重试、死信、重放、投递记录、告警 |
| 控制台范围膨胀 | 交付延期 | P0 页面清单冻结；体验页/可视化编排放 P2 |
| 审批等待阻塞 | 并发占用 | 超时策略、通知、审批人分组、队列上限 |
| SSO/IdP 不可用 | 全体用户无法登录 | 应急管理员、会话有效期、IdP 多副本、登录监控 |
| Connector 配置/撤销异常 | 入站/出站中断或越权 | 失败关闭、LKG、心跳/漂移告警、开关回滚、验收清单 |
| 数据权限绕过 | 越权读取/导出 | 统一 QueryFilter、Repository 测试、详情/下载二次校验、审计 |
| 定时任务误触发/堆积 | 成本与副作用 | skip 默认、预算上限、服务账号停用即暂停、失败告警 |
| 发布流程被绕过 | 生产事故 | CI 门禁、镜像 digest、人工迁移闸门、发布记录与回滚演练 |

## 19. 已决策

以下决策已写入设计，不再作为评审阻塞项。

### 19.1 产品与范围

- 管理端 React 19 + Ant Design 5 + BFF 会话；中文 P0，英文 P1。
- 开放 API 使用 `/open/v1`，API Key 鉴权；应用数据范围固定 `app`。
- 控制台上传包仅声明式；代码扩展只走运维安装或 MCP。
- 知识库默认小规模 MySQL 检索，大规模通过适配器接 Qdrant；MySQL 仍是主库。
- **P0 范围**：Webhook、同步便捷调用、`custom_orgs`、定时任务、SSO/Connector 骨架、功能权限矩阵、行级数据权限、服务账号。
- **P1 范围**：英文控制台、字段级脱敏、单条资源共享、知识库/RAG、评测、通知、SDK、Thread API、定时任务补跑/回填。
- **P2 范围**：能力市场、A2A、OpenAI-compatible/MCP Gateway、长期记忆、多租户 SaaS。

### 19.2 身份接入实现策略（三方参数不阻塞开发）

三方参数由 Agent 管理员在部署阶段提供，**不作为设计/开发的前置确认项**：

- Forge 同时实现两种 `access_token` 校验路径，配置 `SSO_TOKEN_VALIDATION_MODE=oidc|agent-principal|both`，默认 `oidc`：
  - `oidc`：按标准 OIDC 校验 `id_token` 与 `access_token`（JWKS、issuer、audience、expiry）；
  - `agent-principal`：`id_token` 仍按 OIDC 校验，`access_token` 按 Agent Connector 固定公钥验签，并校验 `sub` 与 ID Token 对齐；
  - `both`：两者都通过才建立会话；联调确认后固定为实际模式，不保留模糊回退。
- **角色映射必须显式配置**。映射为空时拒绝 SSO 登录（`SSO-1201`），由应急管理员先完成初始化；不按角色 code 自动授权。
- 组织归属默认本地分配；不从邮箱域名推断。未分配组织的用户只有 `self` 数据范围。
- Connector 的 System ID、Connector ID、issuer/clientId/audience、配置公钥、角色 code/name、入站/出站 grant 由 Agent 管理员提供；Forge 用占位配置与 Mock IdP 完成开发/测试，不写死任何环境值。
- 未提供参数时：Connector 三个开关保持 `false`，SSO 可先用应急管理员完成配置；不影响 P0 代码交付，只影响生产开通。
- 具体参数清单见 [sso-and-connector.md](sso-and-connector.md) 第 10 节。

## 20. P0 实施顺序（建议）

1. 工程脚手架、CI、MySQL schema/迁移、错误码与 contracts。
2. 统一身份：OIDC SSO、BFF 会话、JIT、角色映射、应急管理员；Agent Connector Runtime 与 `/integration/v1`。
3. 功能权限 + 数据权限：权限目录、角色矩阵、数据范围、Repository 过滤、授权预览、服务账号。
4. 模型网关 + 自定义 Provider + 控制台模型页。
5. 能力包 registry + Agent/Skill/MCP/Tool 资源与安装 API。
6. Temporal 运行时 + 工具/MCP/Skill + SSE + 审批 + 预算 + 定时任务。
7. 控制台 Agent/MCP/Skill/运行/审批/定时任务/权限页。
8. 开放平台 App/Key/配额/Run/Webhook + 文档门户 + 应用数据隔离。
9. 审计、凭据、设置、备份、Compose、发布流程与回滚演练。
10. 契约测试、E2E、SSO/Connector 验收、数据权限矩阵、负载与安全收口。
