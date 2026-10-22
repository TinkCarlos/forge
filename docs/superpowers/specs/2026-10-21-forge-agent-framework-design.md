# Forge 企业级 Agent 开发框架 设计文档

> **历史版本（V1）**：保留用于追溯。最新设计见 [V2 总体设计](../../02-architecture/system-design.md)，需求见 [产品需求](../../01-requirements/product-requirements.md)，统一登录/权限/发布见 [文档索引](../../README.md)。

日期：2026-10-21　状态：设计已确认，待用户审阅

## 1. 目标与约束

- 定位：为企业级 agent 应用提供固定、可定制程度高的开发框架。新客户项目 = 引用框架库 + 编写配置（AgentSpec）、业务工具和 Skill。
- agent 需具备能力：调用三方接口、工具、Skill、MCP；识别图片和文档；查看网页。
- 运行形态：服务端；以**私有化部署**为主（每客户一套独立环境，客户内部再分组织/部门/用户）。
- 规模：几十人同时在线。
- 模型：客户环境可访问公网主流模型 API。
- 三方接口：对方是 Python 服务，但对外提供 HTTP 接口。
- 持久化执行：Temporal（小时级/跨天任务、多次人工审批）。
- 内核：**TypeScript + Pi 1.3.x**（与 Rova 桌面端共用内核技术栈）。

## 2. 技术栈

| 层 | 选型 |
| --- | --- |
| 语言/工程 | Node 24、TypeScript、pnpm workspace |
| Agent 内核 | `@earendil-works/pi-ai`、`pi-mcp`（锁 1.3.x），`AgentTool` + TypeBox 工具规范，SKILL.md |
| 编排 | Temporal TypeScript SDK（Temporal 自身持久化也用 MySQL） |
| 接入 | Fastify + SSE |
| 存储 | MySQL（Drizzle ORM）、Redis（事件推送、限流）、对象存储（MinIO/S3/COS） |
| 能力服务 | Python 文档解析/OCR（Docling 或 MinerU）、Playwright 浏览器，均以 MCP 提供 |
| 观测 | pino 结构化日志、OpenTelemetry → 自托管 Langfuse、Temporal UI |
| 不使用 | LiteLLM（pi-ai 已多模型，额外网关会丢失厂商原生特性）；限流用 Temporal 队列并发上限 + Redis 令牌桶 |

Pi 版本变化快，`packages/core` 对外只暴露 forge 自己的接口，Pi 升级或更换只影响适配层。

## 3. 模块划分

- `packages/core`：AgentSpec 解析校验；`ForgeError` 与错误码注册表；公共类型；Pi 适配层。
- `packages/capabilities`：统一工具注册表，五类来源：原生工具；OpenAPI 转工具；MCP（pi-mcp）；Skill 库；内置能力（web_fetch、文档解析、图片多模态输入）。
- `packages/governance`：策略快照、风险分级、审批、凭据库接口、审计。
- `packages/runtime`：`AgentRunWorkflow`、activities（prepareContext / callModel / executeTool）、worker。
- `packages/server`：Fastify API、SSE、SSO（OIDC/JWT）鉴权、文件上传。
- `packages/store`：Drizzle schema 与迁移（runs、messages、approvals、audit_logs、policies）。
- `packages/eval`：黄金场景、录制回放。
- `services/doc-parser`（Python）、`services/browser`（Playwright）：以 MCP 形式提供。
- `apps/example-agent`：示例应用。
- `deploy/`：docker-compose、Helm。`docs/`：设计文档、自动生成的 `error-codes.md`。

## 4. AgentSpec 示例

```yaml
name: contract-reviewer
model: anthropic:claude-sonnet-5-5
fallbackModel: openai:gpt-5
instructions: prompts/reviewer.md
skills: [contract-review]
toolsets:
  - openapi: specs/erp.yaml
    allow: [get_contract, list_suppliers]
  - mcp: doc-parser
  - builtin: [web_fetch]
approval:
  highRisk: [submit_approval]
  timeout: 72h
limits: { maxSteps: 50, maxCostUsd: 2 }
output: schemas.ReviewResult
```

## 5. Pi 与 Temporal 的结合（工作流驱动循环）

- 工作流自身驱动 agent 循环，持有上下文引用（上下文存 MySQL，不进 Temporal 事件历史）。
- 每次模型调用、每次工具调用都是独立 activity，崩溃后从上一个完成步骤继续。
- 复用 Pi：pi-ai（多模型、流式、图片输入、成本）、pi-mcp、AgentTool 规范、SKILL.md。不复用 `Agent` 类循环，自写（约数百行）。
- 用户中途插话通过信号实现，在下一次调模型前并入上下文。

## 6. 一次运行的数据流

1. `POST /runs`：鉴权（客户 SSO JWT）→ 解析组织/部门/角色 → 生成**策略快照**（可用工具、模型、预算）→ 写运行记录 → 启动 `AgentRunWorkflow` → 返回 `runId`；前端订阅 `GET /runs/:id/events`（SSE）。
2. 循环每步：
   1. prepareContext（activity）：读历史、拼入 Skill 目录，超阈值先压缩。
   2. callModel（activity，`llm` 队列）：token 实时推 Redis；完整消息落库；返回工具调用与用量。
   3. 预算检查（工作流内）：累计 token/成本/步数，超限结束，状态“预算耗尽”。
   4. 工具调用检查（工作流内，只读策略快照）：无权限 → 作为工具错误返回模型；高风险 → 状态“等待审批”，推送事件，等待批准/驳回信号，超时按驳回。
   5. executeTool（activity，按类型分 `http`/`mcp`/`browser`/`docparse` 队列）：执行时才从凭据库取密钥注入；幂等键 `runId:toolCallId`；写审计；大结果存对象存储、上下文只放摘要；高风险工具执行前**实时重新校验权限**。
3. 结束：无工具调用时用 TypeBox 校验结构化输出，不合格反馈模型重试至多 N 次，通过后落库，状态“成功”。

运行状态：排队 → 运行中 → 等待审批 → 成功 / 失败 / 已取消 / 预算耗尽。

## 7. 治理

- 权限：组织/部门/用户/角色决定可用工具、Skill、MCP、模型；创建 agent 注册全集，运行时按策略快照裁剪。
- 审批：工具按风险分级，高风险走 Temporal 信号等待人工；低风险可自动放行（可选模型预审，后续迭代）。
- 凭据：凭据库，仅在 activity 执行时注入，不进提示词、不进 Temporal 事件历史。
- 审计：每次模型请求与工具调用写 MySQL 审计表。
- 沙箱：Pi 无内置沙箱；服务端禁用 Pi 内置 bash/文件工具，执行代码类能力放入隔离容器服务。

## 8. 并发与限流（几十人在线）

- 瓶颈在模型限流与重资源工具，而非框架。
- Temporal 任务队列按资源拆分：`llm`（并发可高）、`browser`（严格限制）、`docparse`（按 CPU/GPU）、`http`、`mcp`。
- 模型限流：按厂商设置队列并发 + Redis 令牌桶；失败切备用模型；按用户/部门额度。
- 单用户公平性：每用户同时运行数上限（默认 3），超出排队。
- 起步部署：2 个 API 实例 + 2~3 个 worker，水平扩容。

## 9. 三方接口对接

1. 对方有 HTTP 接口（当前主要场景）：有 OpenAPI 则自动转工具；无则手写薄封装。
2. 仅有 Python SDK 的即时调用（预留）：FastMCP 包装为 MCP 服务，TS 侧经 pi-mcp 接入。
3. Python 长任务（预留）：Python Temporal activity，放独立任务队列，由 TS 工作流调度。

所有工具调用统一经过治理包装器后再派发，Python 侧只写业务逻辑。

## 10. 错误处理

- 模型失败：限流/5xx 由 Temporal 退避重试；上下文超长先压缩再重试；连续失败切备用模型。
- 工具失败：业务错误（4xx）不重试，返回模型；基础设施错误（5xx/超时）Temporal 重试，幂等键防重复；重试用尽后作为工具错误交还模型。
- 取消：信号取消运行中的 activity（长任务心跳感知）。
- worker 崩溃：Temporal 重放，已完成步骤不重做。

## 11. 错误码与日志规范

**注册表**：所有错误码只定义在 `packages/core/src/errors/codes.ts`。每个码必须含：`code`（域-四位编号，如 `HTP-4002`）、`meaning`（开发/运维含义）、`userMessage`（中文用户提示）、`remedy`（处理建议）、`httpStatus`、`retryable`、`audience`（用户/模型/仅内部）。

- 代码只能抛 `ForgeError(code, context, cause)`，`code` 为字面量联合类型，不存在的码编译期报错。
- `docs/error-codes.md` 由注册表自动生成；测试校验：编码不重复、均有含义、文档与注册表同步。

**分域**：

| 号段 | 域 | 示例 |
| --- | --- | --- |
| `AUTH-1xxx` | 鉴权 | `AUTH-1001` 令牌缺失或过期 |
| `POL-2xxx` / `APR-21xx` | 权限 / 审批 | `POL-2001` 角色无权使用该工具；`APR-2102` 审批超时 |
| `MDL-3xxx` | 模型 | `MDL-3001` 被限流（可重试）；`MDL-3002` 上下文超长（触发压缩） |
| `HTP-40xx` / `MCP-41xx` | 三方接口 / MCP | `HTP-4001` 业务错误（不重试，交模型）；`HTP-4002` 5xx（重试） |
| `BRW-42xx` / `DOC-43xx` | 浏览器 / 文档 | `DOC-4302` OCR 识别失败 |
| `BUD-5xxx` / `OUT-6xxx` | 预算 / 输出校验 | `BUD-5001` 成本预算耗尽 |
| `RUN-7xxx` / `CFG-8xxx` / `SYS-9xxx` | 运行 / 配置 / 基础设施 | `SYS-9002` 凭据库读取失败 |

**日志**（pino 结构化 JSON）：每条错误日志固定含 `code`、`message`、`runId`、`workflowId`、`activity`、`toolName`、`traceId`、`userId`、`orgId`、`durationMs`、完整原因链。三方接口出错额外记录对方状态码、对方请求 ID、接口路径（去除查询参数中的密钥）、截断响应体。`Authorization`、令牌、密钥统一脱敏。每个错误只在最外层边界记录一次。

**三类受众**：用户看到「中文提示 + 错误码 + runId」；模型只看到简短工具错误；运维看完整日志。接口响应与 SSE 错误事件统一为 `{code, message, runId, traceId}`。

## 12. 测试策略

- 单元：权限判断、AgentSpec 校验、错误码注册表一致性、OpenAPI 转工具（模拟 HTTP 服务）、幂等键。
- 工作流：Temporal 测试环境跳过时间，覆盖审批超时、取消、重试、预算耗尽；历史回放测试防非确定性。
- agent 循环：pi-ai Faux Provider 跑确定性多步工具调用，不耗真实 token。
- 黄金场景：每晚用真实模型跑示例应用。
- 端到端：docker-compose 拉起全套，从 API 发起运行直至审批和结束。

## 13. 已知风险

- Pi 版本迭代快（0.83 → 1.3.0 且包名迁移过）：通过适配层隔离，锁版本，升级走回归测试。
- Pi 无内置沙箱：禁用内置工具，代码执行类能力隔离部署。
- Pi 的 `Agent` 循环不进工作流，自写循环需覆盖插话、并行工具执行、终止条件，需单独测试。
- Temporal 增加运维面：私有化交付包需含 Temporal 与运维说明。

## 14. 不在首版范围

SaaS 多租户共享部署、模型预审审批（ApprovalReviewer 类能力）、Python 长任务 activity 与 Python SDK 包装（仅预留接口）、桌面端集成。
