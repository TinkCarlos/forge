# Forge 实现状态（0.1.0 MVP）

核对日期：2026-10-31。本文按当前集成代码记录实现、限制和本轮验证；[总体设计](../02-architecture/system-design.md)中的 V2 目标不等于已经交付的能力。

## 1. 当前工程与运行方式

| 项目 | 实际实现 |
| --- | --- |
| Node.js | 当前安装基线固定为 Node 22：`.nvmrc` 为 22，`engines` 为 `>=22 <23`，`.npmrc` 开启 `engine-strict`。本轮使用 22.23.3；V2 文档中的 Node 24 尚不是当前安装基线 |
| 工程 | TypeScript strict、pnpm workspace、ESLint；并非 Biome |
| API | Fastify 5；`/auth`、`/admin/api`、`/open/v1`、`/integration/v1`、`/healthz`、`/readyz` |
| 数据与迁移 | MySQL、mysql2、手写 SQL Repository；`packages/store/src/schema.sql` 与 `scripts/migrate.ts`，当前迁移 001–008；未使用 Drizzle |
| Agent 执行 | 自有模型/工具循环、MySQL 队列、租约与心跳；没有接入 Pi、Temporal 或 Redis |
| 进程 | API 可内嵌 worker；也可用 `apps/worker` 独立运行。调度与 Webhook 由 runtime 轮询处理 |
| 会话 | MySQL `auth_sessions` / `auth_oidc_states`，不是旧版内存 Map，也不是 Redis |
| 控制台 | `/` 为原生 HTML/CSS/JS 控制台；`/next/` 为 React 19 + Vite + shadcn/Radix + Tailwind + TanStack Router/Query/Table |
| 构建 | `pnpm build` 仅运行服务端类型检查；实际前端产物由 `pnpm build:console` 生成到 `apps/console/dist`，API 静态托管 |
| 模块 | 已有 core、store、identity、governance、models、capabilities、runtime；contracts、registry、sdk、eval、testkit 等目标包尚未独立实现 |

主链路：API 鉴权与授权 → 创建 Thread/Run → MySQL 认领 → 读取 Agent 版本、解析 Skill/工具/模型 → 模型与工具循环 → 审批或终态 → MySQL 事件/SSE/Webhook。

## 2. 已实现的能力

### 2.1 Agent、模型与工具（FR-AG / FR-MD / FR-MCP / FR-SK / FR-TL）

- Agent 草稿、发布、启停与 API 开放开关；Run 保存 `agent_version_id`。发布新 Agent 版本不会替换已有 Run 的 Agent 版本。
- 模型支持 `mock` 与 `openai-compatible`，包括工具调用解析、用量与成本计算、可重试错误、fallback、上下文裁剪、最大步数/成本限制、JSON Schema 输出校验与修复重试。
- Skill 保存与发布 Markdown 内容，并注入系统提示词；这不是脚本执行或完整技能沙箱。
- 内置工具、HTTP Streamable MCP（initialize、tools/list、tools/call）、OpenAPI 3.x 工具导入与执行；按 Agent toolsets 暴露工具。
- 出站访问统一校验协议、主机/IP、DNS 解析结果、重定向与地址范围；默认拒绝私网等受限目标，按 `OUTBOUND_ALLOWLIST` 的 `host:port` 显式放行。旧 `TOOL_ALLOW_PRIVATE_NETWORK` 不再绕过检查。
- Provider 凭据与 Webhook Secret 加密保存；API Key 保存不可逆摘要。前端响应、事件、日志等路径有敏感信息屏蔽。

**版本限制**：固定 Agent 版本尚不等于完整依赖快照。Skill 仍按 key 读取已发布内容，模型与工具配置在执行时解析；暂停后恢复可能读取更新后的配置。尚未实现 V2 的完整 Run 策略/依赖版本冻结。

### 2.2 Run、审批与故障恢复（FR-RT / FR-GV）

- `threads/runs/messages/tool_calls/approvals/run_events/run_steps` 持久化在 MySQL；支持同一 Thread 继续发起 Run。
- 队列认领使用事务与 `FOR UPDATE SKIP LOCKED`；租约到期后可被其他 worker 接管。worker id 包含 `hostname:pid:epoch`，避免进程 PID 复用被识别成原持有者。
- 运行中的写入通过租约作用域加持有者条件；失去租约后停止落库，并向模型/HTTP/MCP/OpenAPI 调用传递中止信号。心跳异常只容忍到安全截止时间，不会无限继续执行。
- 模型步骤中断后允许重试；工具调用保存只读/副作用标记。接管时只读调用可重跑，有副作用的中断调用改为人工确认，避免直接重复发送。
- OpenAPI 工具请求携带由 Run 与工具调用记录派生的稳定幂等键；是否真正避免下游重复副作用仍取决于下游处理。MCP 与 web_fetch 不携带同样的幂等头。
- 高风险或显式指定工具进入审批；批准/驳回后继续执行。审批过期不可再决定，worker 扫描过期审批；超过宽限仍未完成的 Run 以 `APR-2102` 失败。
- 决定审批与取消围绕同一 Run 串行化；取消请求接受后，正在进行的工具调用先完成，随后 Run 取消。worker 补扫已请求取消但未完成收尾的 Run。
- SSE 从数据库事件按序号续传；对外 `message.delta` 已停用，只发送打码后的完整消息事件。不能将当前能力描述为浏览器逐 token 展示。

### 2.3 身份、权限与审计（FR-GV / FR-DLV）

- 本地应急登录、签名会话 Cookie、CSRF、OIDC 授权码 + PKCE、discovery/JWKS 与显式角色映射；映射失败拒绝登录。
- 会话与 OIDC state 存入 MySQL；存储 token/state 摘要，每次请求重新读取用户与组织状态，停用/角色变更不会继续沿用旧 Principal 快照。会话按到期时间判断有效性，并有过期清理任务。
- Cookie 始终 HttpOnly/SameSite=Lax；仅明确 `NODE_ENV=development|test` 时关闭 Secure，未设置环境按生产安全默认处理。
- 固定角色矩阵、组织/本人/应用等数据范围、Run/审批/SSE/写操作的服务端校验；审计记录资源所属组织，查询按调用者范围过滤。
- API Key 的有效 Scope 为 Key 创建时 Scope 与应用当前 Scope 的交集；不支持 `*` 通配授权。
- Connector 已实现 Principal 验签、环境/issuer/audience 检查与主体映射。完整 SDK 制品接入、签名配置刷新/LKG、心跳、出站 `callSystem` 未实现，不能视为已完成企业真实联调。
- 尚无可配置的完整功能权限矩阵与 deny 优先数据策略引擎；`data_policies` 表存在不代表已接入执行。也未统一实现 V2 要求的所有 Repository `AccessContext/QueryFilter` 契约。

### 2.4 开放平台、定时任务与能力包（FR-OP / FR-TR / FR-PL）

- API App/Key/Scope，已发布 Agent 目录，创建/读取/取消 Run、结果与 SSE；`Idempotency-Key` 支持同请求重放、异请求冲突。
- `invoke?wait=` 在 1–120 秒内等待，未到终态返回 202；通过 `threadId` 续聊，但独立 Thread CRUD、运行中插话、File/Artifact API 未实现。
- 每分钟限流为 API 进程内固定窗口；每日 Run 配额查询数据库。没有 Redis 分布式限流，也没有完整月成本/并发配额。
- Webhook HMAC-SHA256 签名、投递落库、重试与管理端重放；当前一个应用一个 Webhook URL。
- Cron/时区调度、启停、立即执行、下次运行时间；绑定服务账号时以该账号的身份和当前权限执行，账号/Agent 不可用时暂停，默认并发 `skip`。仍是 MySQL 轮询，并非 Temporal Schedule。
- 声明式 JSON 能力包可安装 Agent/Skill/MCP/Provider；校验输入，记录资源，安装失败补偿本次新建资源，重复安装合并记录，卸载保留审计与状态。不是完整 `.forgepkg` checksum/签名/依赖解析/升级回滚系统。

### 2.5 控制台（FR-UI）

- 旧控制台覆盖总览、Agent、模型、MCP、Skill、工具、能力包、Run/审批、定时任务、应用与密钥、用户/服务账号、SSO 与审计等操作。
- 新控制台已实现登录、Agent 列表与审批列表等，其他业务入口仍跳转旧控制台。不是全部页面已经完成 React 迁移。
- 新旧界面有权限入口、错误码、网络失败提示、取消请求状态、审批接管状态、长文本/响应式处理；`/next/` 审批页重新可见时限频刷新。
- SSO 失败只展示固定码表文案，URL 中的登录错误参数清除后仍保留页面提示；未知值不作为 HTML 展示。
- 前端有 Vitest 回归与 CSP 构建检查；尚无项目级 Playwright 全流程验收套件。

## 3. 停机与部署边界

- API 收到 SIGTERM/SIGINT 后停止领任务并开始排空，关闭监听/SSE，等待在途任务，再关闭数据库连接池和刷新日志。
- API 的 Run 排空上限为 `min(WORKER_DRAIN_TIMEOUT_MS, 5000)`；释放租约封顶 1000ms，连接池关闭封顶 1000ms且受总预算约束，正常日志 flush 封顶 2000ms。
- 正常关闭按收到信号后的 9000ms 截止时间分配预算；兜底路径以 9400ms 为目标调用退出，预留定时器迟到余量，测试约束在 9500ms 内调用退出。`exit_call` 单调时钟记录位于日志 flush 后、实际退出调用前；`exit` 是最后一个 phase。
- 工具全部结束才主动释放租约；仍有调用未结束时等待租约自然过期。每个 Run 记录 `run_handoff`，区分 `released` 与 `lease_expiry`。
- 独立 worker 按 `WORKER_DRAIN_TIMEOUT_MS` 排空，连接池关闭最多 1000ms，进程兜底为排空上限加 5 秒。超时/失败退出码为 1；成功为 0。
- 生产迁移和部署仍需遵循[发布流程](../06-operations/release-process.md)。本轮本地验证不代表已经部署，亦不证明真实 SSO/Connector 联调通过。

## 4. 配置与验证方式

关键配置：`DATABASE_URL`、`FORGE_MASTER_KEY`、`SESSION_SECRET`、`API_KEY_PEPPER`、`FORGE_ADMIN_PASSWORD`、`OIDC_*`、`AGENT_CONNECTOR_*`、`OUTBOUND_ALLOWLIST`、`EMBEDDED_WORKER`、`MAX_CONCURRENT_RUNS`、`LEASE_TTL_SECONDS`、`WORKER_DRAIN_TIMEOUT_MS`、`APPROVAL_EXPIRED_GRACE_SECONDS`。

测试必须显式设置 `TEST_DATABASE_URL` 且库名以 `_test` 结尾；不会继承 `.env` 中的业务库作为测试目标。迁移/seed 对非 `_test`/`_ux` 库要求精确确认参数；reset 另要求明确的开发/测试环境与重置开关。

当前有效命令：

```bash
pnpm db:migrate
pnpm db:seed
pnpm verify
pnpm build
pnpm smoke:isolated
pnpm smoke:sso
```

- `verify` 包含服务端/前端 typecheck、lint、前端生产构建、后端单元/真实 MySQL/接口契约测试及前端测试。
- 仓库没有独立的 `test:integration`、`test:contract` 脚本；相关用例由 `pnpm test` 执行，不应把不存在的命令写成已通过。
- `smoke:isolated` 要求先启动本地 mock services，使用独立 `_test` 库及空闲 API 端口；测试涉及写入，禁止指向业务库。
- `verify:envs` 可进一步验证 development/test/未设置 NODE_ENV 三种环境；是否执行应在验证记录中明确。

### 4.1 2026-10-31 集成验证

环境：Node 22.23.3、本机 MySQL 8.4.13、隔离测试数据库。旧文档的“26/26 通过”属于早期 MVP 历史记录，不作为本轮证据。

| 检查 | 本轮结果 |
| --- | --- |
| 空库迁移 001–008 + seed | 通过 |
| `pnpm verify` | 通过：后端 164 文件 / 2063 用例，前端初次 42 文件 / 509 用例；补入弹窗 close 时序回归后，前端重跑 42 文件 / 510 用例通过，无 skip/todo |
| `pnpm build` | 通过；最终脚本修改后重新 typecheck 通过 |
| `pnpm smoke:isolated` | 通过：工具、审批、调度、开放 API、幂等、Thread 续接、数据范围、包安装、审计、SSE 续传、过期租约接管 |
| `pnpm smoke:sso` | 通过：本地 Mock OIDC 与 Connector Principal 验签/主体映射 |
| 真实浏览器 | ego lite：登录与 SSO 错误参数清理、Agent/审批页面、试运行后取消并保持详情同步；审批可见事件使用浏览器内派发 visibilitychange 验证，原生切换标签页行为未独立验收 |

Lint 有 4 条既有 React Fast Refresh warning（0 error）；后端测试输出既有 Ajv union-type 提示。未执行 `verify:envs` 的 development/unset 全套重复检查。

本轮浏览器验收补充发现并修复：复用同一个 dialog 后，旧表单延迟送达的 close 事件误关闭 Run SSE；新增回归先失败后通过，取消后弹窗可持续更新为 cancelled。冒烟原先还断言已禁用的 message.delta，现按当前契约检查完整消息、无 delta、严格递增事件序号与精确续传。

本轮整理了 80 个本地分支引用：有效独有改动合入，rebase/cherry-pick 等价改动去重，已被新实现替代的旧实现不覆盖现行代码；公开前备份与其他历史恢复引用继续保留。QA 分支的文档作为历史用例材料合入，其旧执行日期/结果不等于本轮全量人工验收。

## 5. 尚未完成与验收限制

- Temporal、Redis、Drizzle、Pi 适配与完整 contracts/OpenAPI 代码生成/SDK 尚未实现。
- 完整 Run 依赖与策略冻结、动态权限策略、资源共享、标准化签名能力包/依赖生命周期尚未完成。
- MCP stdio/OAuth、Connector 完整生命周期、文件/OCR/Artifact、知识库、评测、通知尚未交付。
- 生产高可用、分布式限流、真实模型高并发压测、真实公司 SSO/Connector、发布回滚演练未在本轮验收。
- Mock OIDC/Connector 测试只能证明覆盖到的本地协议路径；不替代生产严格模式、真实身份提供方与公司权限配置验收。
