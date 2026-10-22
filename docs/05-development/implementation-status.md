# Forge 实现状态（0.1.0 MVP）

日期：2026-10-21　状态：可运行 MVP

> 目标架构见 [system-design.md](../02-architecture/system-design.md)。本文记录**代码实际实现**，避免 AI/开发者把目标能力误认为已完成。

## 1. 验证证据

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `pnpm typecheck` | 通过 |
| 单元 + 集成测试 | `pnpm test` | 26/26 通过（真实 MySQL），含租约续跑、并行工具、SSE、Schema 修复、fallback、幂等键、Webhook 重试、同步等待与会话续接 |
| 端到端冒烟 | `pnpm smoke` | MCP、审批、OpenAPI、定时任务、开放 API、幂等键、同步 invoke、同一 thread 续聊、数据范围、能力包、审计、SSE 续传、过期租约续跑全部通过 |
| 编辑流程 | `pnpm smoke:edit` | Agent 新版本、MCP/Skill/Provider/Model/App/Schedule 修改通过 |
| SSO/Connector | `pnpm smoke:sso` | Mock OIDC 授权码回调、角色映射、Principal 验签与主体映射通过 |
| 控制台 | 浏览器打开 `http://localhost:3100` | 登录、总览、Agents 列表正常渲染；已做结构快照验证 |

复现前提：MySQL 8 可连接；`pnpm db:migrate && pnpm db:seed`；`pnpm dev`；`pnpm mock:services`（MCP/OpenAPI 用例）。

## 2. 已实现

### API / 控制台
- Fastify 服务：`/auth`、`/admin/api`、`/open/v1`、`/integration/v1`、`/healthz`、`/readyz`、`/assets`、`/`。
- 本地管理员登录（scrypt + 签名 Cookie + CSRF）；OIDC 登录（授权码 + PKCE + discovery/JWKS）；Connector Principal 验签。
- 控制台：总览、Agents、模型、MCP、Skills、工具源、能力包、运行中心、审批、定时任务、应用与密钥、用户与权限、SSO/Connector。
- 支持新增、编辑、发布、启停、运行、审批、密钥创建等操作。

### Agent / 模型
- Agent 草稿与发布版本；运行固定版本；spec 支持 model/skills/toolsets/limits/approval/output schema。
- Provider：`mock` 离线模型 + `openai-compatible`；模型目录、能力、上下文、价格字段；API Key AES-256-GCM 加密。
- 运行循环：系统提示 + Skill 注入 + 工具调用 + 工具结果回填 + 最大步数 + 成本上限 + JSON Schema 输出校验与修复重试。
- 运行时加固：MySQL 租约认领与过期续跑、`run_steps`、流式 `message.delta`、低/中风险工具并行、上下文压缩、主模型可重试错误后的 fallback。编排仍是 MySQL 队列，不是 Temporal。
- 运行数据：threads、runs、messages、tool_calls、approvals、run_events、run_steps，全部 MySQL。
- 后台：API 内嵌 worker（`EMBEDDED_WORKER=true`）或独立 `apps/worker`；MySQL 队列轮询，单进程并发由 `MAX_CONCURRENT_RUNS` 限制。

### MCP / 工具 / Skill
- HTTP Streamable MCP：initialize、tools/list、tools/call；工具风险从 annotations 推断。
- 工具名归一化为 OpenAI 兼容函数名；MCP/OpenAPI 工具通过 `toolsets` 白名单暴露。
- OpenAPI 3.x 导入：paths/operations → tools，基础参数与 requestBody Schema；HTTP 执行、SSRF 默认拒绝私网（可用 `TOOL_ALLOW_PRIVATE_NETWORK` 放开）。5xx/429/超时记为 `HTP-4002` 并按 `TOOL_MAX_ATTEMPTS` 重试，4xx 直接交还模型。
- Skill：SKILL.md 内容、发布版本、注入上下文。

### 安全与治理
- 功能权限：静态角色矩阵（platform_admin/org_admin/builder/operator/auditor/user），API 服务端校验。
- 数据范围：`all/org/self/app`；Run 列表/详情/SSE/取消/审批做过滤；org 使用子树；API App 仅自身 Run。
- 审批：高风险工具/显式审批工具暂停 Run，批准/驳回后恢复；超时标记 expired。
- 审计：登录、创建、发布、取消、审批、安装等写入 `audit_logs`。
- 加密：Provider 密钥与 Webhook Secret 使用主密钥加密；API Key 只存 HMAC 哈希与前缀。

### 开放平台 / 调度 / 包
- API App、Key、Scope、每分钟限流、每日配额；Run 创建/查询/SSE/结果/取消。
- 创建 Run 支持 `Idempotency-Key`：相同请求重放首次结果，不同请求体返回 `OPN-4503`。
- `POST /open/v1/agents/{key}/invoke?wait=` 在 1–120 秒内等待终态；超时返回 202。`threadId` 可把新 Run 接到同一会话，模型能看到该会话里已有的消息。
- Webhook：HMAC-SHA256 签名，投递写入 `webhook_deliveries`。2xx 完成；5xx/429/408/网络错误按 1 分钟、5 分钟、30 分钟、2 小时、6 小时重试；其他 4xx 停止。管理端可查看并重放。当前一个应用一个 Webhook URL，还没有独立 endpoint 表。
- 定时任务：Cron/时区、启停、立即运行、下次运行时间；以创建者身份运行。
- 能力包：声明式 JSON 安装 Agent/Skill/MCP/Provider；记录安装状态与卸载标记。

## 3. 与目标架构的差异

| 目标 | 当前实现 | 影响 / 下一步 |
| --- | --- | --- |
| Temporal 持久化工作流 | MySQL 队列 + 租约续跑 + `run_steps` | 已落库步骤可恢复；未落库模型调用至少再执行一次。编排仍不是 Temporal；P1 只替换调度器 |
| Redis SSE/限流/会话 | 内存会话 + DB 事件轮询 + 内存限流 | 多实例部署会话/SSE 不共享；P1 接 Redis |
| Drizzle ORM | mysql2 + 手写 SQL Repository | 表结构以 MySQL 设计为目标；P1 可迁移 Drizzle |
| React + Ant Design 控制台 | 原生 HTML/CSS/JS 控制台 | 功能可用，无构建链；P1 可替换 |
| MCP stdio / OAuth | 仅 HTTP MCP | P1 增加进程管理与 OAuth |
| Agent Connector 完整生命周期 | Principal 验签 + 主体映射 | 缺少签名配置刷新/LKG/心跳/出站 `callSystem`；P1 |
| 功能权限矩阵 | 静态角色矩阵 + 用户数据范围 | 控制台展示矩阵，尚不能自定义角色权限；P1 |
| 数据权限策略表 | 角色 + `users.data_scope` | 未使用 `data_policies` 表；P1 支持自定义范围 |
| 文件/OCR/Artifact | 未实现 | P1 |
| 知识库/评测/通知 | 未实现 | P1 |
| `.forgepkg` 签名包 | JSON 声明式安装 | P1 增加 zip/manifest/checksum/签名 |
| Helm/离线包/HA | Compose/本地运行 | P1 |

## 4. 运行配置

- `DATABASE_URL`：MySQL 连接串。
- `FORGE_MASTER_KEY`：32 字节 base64，用于 AES-256-GCM；丢失将无法解密 Provider/Webhook 密钥。
- `FORGE_ADMIN_EMAIL` / `FORGE_ADMIN_PASSWORD`：首次 seed 的应急管理员。
- `ALLOW_LOCAL_LOGIN`：本地登录开关；生产应配合 SSO 并仅保留应急管理员。
- `OIDC_*`、`SSO_TOKEN_VALIDATION_MODE`、`CONNECTOR_PRINCIPAL_*`、`AGENT_CONNECTOR_*`：统一登录/Connector。
- `TOOL_ALLOW_PRIVATE_NETWORK`：默认 `false`；本地演示 MCP/OpenAPI 时可临时开启。
- `EMBEDDED_WORKER`：单进程开发默认 `true`；生产拆分 worker 时在 API 设为 `false`，单独运行 `apps/worker`。
- `MAX_CONCURRENT_RUNS`：单进程同时执行的 Run 数，默认 `2`。
- `LEASE_TTL_SECONDS`：运行租约秒数，默认 `30`；worker 在租约到期前续租，过期后其他 worker 可重领。
- `MODEL_MAX_ATTEMPTS`：单个模型候选的可重试次数，默认 `2`，耗尽后才切 `fallbackProvider` / `fallbackModel`。
- `DEFAULT_MAX_CONTEXT_TOKENS`：未在 AgentSpec 指定 `limits.maxContextTokens` 时的压缩阈值，默认 `8000`。
- `DEFAULT_MAX_PARALLEL_TOOLS`：未指定 `limits.maxParallelTools` 时的并行工具上限，默认 `4`。
- `TOOL_MAX_ATTEMPTS`：单个工具调用遇到可重试错误时的尝试次数，默认 `2`。

## 5. 未覆盖的验收项

- 真实公司 IdP 与 Agent Portal 联调（需要第三方参数）。
- 多实例会话共享、Redis 事件、K8s/Helm 发布。
- Temporal 历史回放与长任务回调。MySQL 租约已覆盖「进程崩溃后从已落库步骤继续」。
- 文件/知识库/评测/字段级脱敏/资源共享。
- 通过真实 OpenAI-compatible 端点的高并发/限流测试（当前 Mock 与本地 HTTP 工具已覆盖协议路径）。
