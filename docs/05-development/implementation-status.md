# Forge 实现状态（0.1.0 MVP）

## 2026-11-01 Job/消息开发进度（基础批次）

状态：**PARTIAL IMPLEMENTATION / 整体未验收**。已按四份定稿文档开始开发，完整REQ/27项AC及E1–E8保留；唯一进度入口为[闭环记录](../../.closed-loop/tasks/20261101-job-message/progress.md)。

当前代码：Job/消息输入契约、确定性映射/条件与图校验、完整ULID出口、错误和权限目录；Job定义/发布/显式App授权及同连接原子受理Repository；allow-minus-deny并交上限的SQL过滤、签名分页；消息模板/指定成员文本/HMAC及分类型响应判定。新增013权限目录和014 Job基础8表，Drizzle共50表；只有本任务隔离MySQL 8.4测试库执行了迁移，日常库和生产未改。

边界：这些仍是内部基础能力，尚未接入新的管理/Open/集成API和控制台。QueryFilter已有SQL编译器，但完整E1策略加载/主体授权仍未实现；Repository要求受信调用方在同事务实时授权。Temporal、Job dispatcher/完整快照、预算账本、执行器、人工/证据/产物、消息渠道Secret/发送账本/旧回调切换及真实业务路径均未完成。不得将技术测试通过解释成Job或消息功能整体完成。现有API/worker未启用新Job outbox消费者，不会因为本批结构迁移启动外部工作或发送消息。

## 2026-11-01 Job与消息管理设计记录

状态：**DESIGNED / NOT IMPLEMENTED / NOT RUN**。用户已采纳[详细需求v1.0](../../.talking-us/20261101-113405-Forge后台优化与Job消息管理-详细需求文档.md)，[开发](../../.talking-us/20261101-113405-Forge后台优化与Job消息管理-开发设计文档.md)、[数据库](../../.talking-us/20261101-113405-Forge后台优化与Job消息管理-数据库设计文档.md)、[接口](../../.talking-us/20261101-113405-Forge后台优化与Job消息管理-接口文档.md)按新Job/统一消息、恢复/人工/证据与版本化交付定稿。

该设计定稿阶段只改文档；当时未新增运行代码、Schema/Drizzle/迁移SQL、OpenAPI/SDK实现产物或环境配置，未运行迁移/产品回归/真实群发送/生产发布。Temporal、完整Job、统一消息渠道与其依赖仍未因设计状态而实现；原E1–E8及U04/U06/U07/U08未完成范围不关闭。下方既有代码验证记录继续按其原范围理解。

核对日期：2026-11-01。本文按当前集成代码记录实现、限制和本轮验证；[总体设计](../02-architecture/system-design.md)中的 V2 目标不等于已经交付的能力。

## 1. 当前工程与运行方式

| 项目 | 实际实现 |
| --- | --- |
| Node.js | 当前安装基线固定为 Node 22：`.nvmrc` 为 22，`engines` 为 `>=22 <23`，`.npmrc` 开启 `engine-strict`。本轮使用 22.23.3；V2 文档中的 Node 24 尚不是当前安装基线 |
| 工程 | TypeScript strict、pnpm workspace、ESLint；并非 Biome |
| API | Fastify 5；`/auth`、`/admin/api`、`/open/v1`、`/integration/v1`、`/healthz`、`/readyz` |
| 数据与迁移 | MySQL、mysql2 SQL Repository；Drizzle ORM 0.45.4/Kit 0.31.11维护50张表Schema及生成SQL，现有唯一迁移执行器执行001–014（013/014仅本任务隔离库已测）；Repository尚未改为ORM查询 |
| Agent 执行 | 自有模型/工具循环、MySQL 队列、租约与心跳；没有接入 Pi、Temporal 或 Redis |
| 进程 | API 可内嵌 worker；也可用 `apps/worker` 独立运行。调度与 Webhook 由 runtime 轮询处理 |
| 会话 | MySQL `auth_sessions` / `auth_oidc_states`，不是旧版内存 Map，也不是 Redis |
| 控制台 | `/` 为原生 HTML/CSS/JS 控制台；`/next/` 为 React 19 + Vite + shadcn/Radix + Tailwind + TanStack Router/Query/Table |
| 构建 | `pnpm build` 仅运行服务端类型检查；实际前端产物由 `pnpm build:console` 生成到 `apps/console/dist`，API 静态托管 |
| 模块 | 已有 core、store、identity、governance、models、capabilities、runtime；contracts 目前包含内部应用/密钥生命周期及统一错误DTO/Schema；OpenAPI产物覆盖已补齐的内部应用/密钥和17个配置写入口，现存输入Schema已移入contracts；registry、sdk、eval、testkit 等目标包尚未独立实现 |

主链路：API 鉴权与授权 → 创建 Thread/Run → MySQL 认领 → 读取 Agent 版本、解析 Skill/工具/模型 → 模型与工具循环 → 审批或终态 → MySQL 事件/SSE/Webhook。

## U03 全局角色增量（2026-11-01，本地验证通过）

已实现角色目录、创建/编辑/启停/复制/内置恢复/引用删除、权限矩阵及预览、用户/服务账号主角色与附加全局角色并集。实际登录、管理/集成API、SSE与调度读取数据库有效权限，不回退静态模板；停用旧绑定保留，不能新授予。授权上限包含停用角色配置，SSO映射保护管理员身份，首次SSO授权持锁核对映射/角色版本，已有绑定保留本地权限。seed不覆盖维护后的矩阵或映射。

统一账号入口支持按任一获准页签进入；新旧控制台正确处理只读/非Agent角色、独立操作权限、写后无读取权限和迟到请求。首次创建Agent发布须agent.publish，能力包安装Agent只建草稿；正常发布仍单独授权。012/Drizzle0004新增4表。

服务端184文件2211项、控制台47文件540项、类型/构建/Lint/Drizzle/错误产物校验和两种Mock冒烟通过；权限及流程两面复审无本批未关闭P0–P2，正常浏览器入口/并发409/390px布局与限制见[roles证据](../../.talking-us/evidence/roles/README.md)。组织/组绑定、完整数据策略/部门树、API目录、可视关联、WeCom及原E2–E8范围继续保留，不能称框架整体完成。

## 2. 已实现的能力

### 2.0.0 账号与操作日志（用户新增优先范围，已本地验证）

已补生产SSO＋本地登录、管理员精确issuer/sub绑定保留本地授权、账号创建/资料/部门/状态/管理员/删除标识重用、改密/重置/撤会话、最后可登录管理员并发保护及安全bootstrap；操作日志检索/分页/详情、安全前后值/操作者快照/失败拒绝记录与正常页面入口。管理/开放SSE按轮询重新认证授权，撤销后结束。新增011、Drizzle0003、内部identity OpenAPI。

服务端2192项、控制台528项、构建/类型/Lint/Schema及Mock smoke通过，详见[本批证据](../../.talking-us/evidence/identity/README.md)。后续全局角色交付见上方U03记录；组织/组作用域、完整数据策略/组织树、三方API目录、能力可视关联与WeCom仍未完成。

### 2.0.1 凭据库（E1，已本地验证）

已实现三类作用域、信封加密及AAD、密钥版本/0600 keyring热替换、只写值管理API及控制台、Secret轮换/启停/引用删除保护、Provider/MCP/OpenAPI/Webhook资源原子绑定与运行时注入。原Header非空值不再存配置表；平台/组织/指定资源使用范围强制校验，停用后失败关闭。010结构扩展、独立旧列迁移及历史DEK重包裹命令已实现，回填覆盖软删除MCP，不自动退役旧key。API Key仍不可逆摘要保存。Agent执行环境的Secret使用随E2/E3实际消费者接入。

本轮服务端2168项、控制台521项、真实MySQL/HTTP边界、独立审查与浏览器主流程通过；完整证据以[开发进度](../../.talking-us/2026-10-31-forge-development-progress.md)最新记录为准。当前没有执行真实生产凭据迁移或Linux部署。运维步骤见[凭据维护](../06-operations/secrets.md)。

### 2.0 配置并发编辑（E1，2026-10-31）

- 18类现有配置表带revision；Agent/Skill版本与发布、MCP刷新、模型/应用/身份/调度/角色映射/卸载写入口要求强If-Match；缺失428、格式400、冲突409。配置更新、子版本绑定和审计同事务，详情/写响应带ETag。
- 控制台捕获已读版本，冲突保留草稿；MCP发现提交再检查源版本，后台停用及受支持的seed/SSO同步使旧表单失效，时钟推进不增配置版本。
- Drizzle覆盖现有34张表；009只新增revision，支持部分DDL后重跑。空库、008升级、重复迁移及列/外键/索引一致性使用本地真实MySQL验证。完整权限策略、依赖快照、Thread等后续E1范围未因此关闭。


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

- 本地账号登录与SSO并行、签名会话 Cookie、CSRF、OIDC 授权码 + PKCE、discovery/JWKS 与显式角色映射；映射失败拒绝登录。
- 会话与 OIDC state 存入 MySQL；存储 token/state 摘要，每次请求重新读取用户与组织状态，停用/角色变更不会继续沿用旧 Principal 快照。会话按到期时间判断有效性，并有过期清理任务。
- Cookie 始终 HttpOnly/SameSite=Lax；仅明确 `NODE_ENV=development|test` 时关闭 Secure，未设置环境按生产安全默认处理。
- 数据库可配置的全局角色/多角色并集、组织/本人/应用等简化数据范围、Run/审批/SSE/写操作的服务端校验；审计记录资源所属组织，查询按调用者范围过滤。
- API Key 生命周期（FR-OP-02）已补齐有效期创建、吊销、重叠轮换及控制台入口；摘要存储，明文仅首次响应，轮换幂等重放只返回元数据，审计与密钥变更同事务。接口与验证状态见[开发进度](../../.talking-us/2026-10-31-forge-development-progress.md)。
- API Key 的有效 Scope 为 Key 创建时 Scope 与应用当前 Scope 的交集；不支持 `*` 通配授权。
- Connector 已实现 Principal 验签、环境/issuer/audience 检查与主体映射。完整 SDK 制品接入、签名配置刷新/LKG、心跳、出站 `callSystem` 未实现，不能视为已完成企业真实联调。
- 角色组织/组作用域绑定与 deny 优先数据策略引擎仍未实现；`data_policies` 表存在不代表已接入执行。也未统一实现 V2 要求的所有 Repository `AccessContext/QueryFilter` 契约。

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
| 空库迁移 001–009 + seed、009部分DDL恢复与重复执行 | 通过；Drizzle列/外键/索引一致，二次seed配置版本递增 |
| `pnpm verify` | 通过：后端 164 文件 / 2063 用例，前端初次 42 文件 / 509 用例；补入弹窗 close 时序回归后，前端重跑 42 文件 / 510 用例通过，无 skip/todo |
| `pnpm build` | 通过；最终脚本修改后重新 typecheck 通过 |
| `pnpm smoke:isolated` | 通过：工具、审批、调度、开放 API、幂等、Thread 续接、数据范围、包安装、审计、SSE 续传、过期租约接管 |
| `pnpm smoke:sso` | 通过：本地 Mock OIDC 与 Connector Principal 验签/主体映射 |
| 真实浏览器 | ego lite：登录与 SSO 错误参数清理、Agent/审批页面、试运行后取消并保持详情同步；审批可见事件使用浏览器内派发 visibilitychange 验证，原生切换标签页行为未独立验收 |

Lint 有 4 条既有 React Fast Refresh warning（0 error）；后端测试输出既有 Ajv union-type 提示。未执行 `verify:envs` 的 development/unset 全套重复检查。

本轮浏览器验收补充发现并修复：复用同一个 dialog 后，旧表单延迟送达的 close 事件误关闭 Run SSE；新增回归先失败后通过，取消后弹窗可持续更新为 cancelled。冒烟原先还断言已禁用的 message.delta，现按当前契约检查完整消息、无 delta、严格递增事件序号与精确续传。

本轮整理了 80 个本地分支引用：有效独有改动合入，rebase/cherry-pick 等价改动去重，已被新实现替代的旧实现不覆盖现行代码；公开前备份与其他历史恢复引用继续保留。QA 分支的文档作为历史用例材料合入，其旧执行日期/结果不等于本轮全量人工验收。

## 5. 尚未完成与验收限制

- Temporal、Redis、Pi 适配、完整 contracts/OpenAPI/SDK 尚未实现；Drizzle现已用于实际Schema与差分SQL，查询仍沿用mysql2。
- 完整 Run 依赖与策略冻结、动态权限策略、资源共享、标准化签名能力包/依赖生命周期尚未完成。
- MCP stdio/OAuth、Connector 完整生命周期、文件/OCR/Artifact、知识库、评测、通知尚未交付。
- 生产高可用、分布式限流、真实模型高并发压测、真实公司 SSO/Connector、发布回滚演练未在本轮验收。
- Mock OIDC/Connector 测试只能证明覆盖到的本地协议路径；不替代生产严格模式、真实身份提供方与公司权限配置验收。

## 6. 本次补充增量（FR-OP-02）

API Key有效期、吊销、重叠轮换、一次性返回与幂等、同事务审计、管理入口及相关contracts/OpenAPI已实现并本地验证。服务端166文件2077项、控制台43文件516项通过；typecheck、Lint、前端构建、隔离端到端与Mock SSO冒烟通过。真实页面验证创建、轮换后新旧Key切换、吊销、刷新读回；剩余批次和验证限制见[开发进度](../../.talking-us/2026-10-31-forge-development-progress.md)。本增量没有新增迁移、提交推送或生产发布，不改变第5节其余未完成项。

## 7. 统一错误增量（W01 / FR-DLV-03部分 / FR-OB-01部分）

已实现core错误注册表、封闭ErrorCode、结构化ForgeError/cause、remedy生成与同步检查；HTTP错误响应统一、5xx固定注册消息、message/details/日志公共脱敏、SSO错误边界记录一次、普通响应X-Request-Id。域内显式异常已归一，内部租约控制信号和标准网络回调协议保留。服务端169文件2086项及最终模块拆分回归6文件76项、控制台516项通过；类型检查、Lint、构建、Mock端到端/SSO冒烟通过。详细限制见开发进度；不代表全量OpenAPI/SDK、Trace或整个后端框架已完成。

### 2026-11-01 Job / 消息续作候选（未提交、未部署）

已新增Job定义管理API/React入口与消息管理24个API/四页签，015消息7表及Drizzle/唯一迁移、版本专属地址Secret、规则/模板版本、outbox冻结匹配、attempt/sendCycle与安全派发。消息sender已接worker，覆盖业务Webhook与WeCom不同响应/未知/有限重试/持久节流和停用竞态。Run终态及待审批在业务事务中冻结通知；保存不发，显式测试与重发/取消有独立权限/ETag/幂等。当前消息仅测试及直接Run/App Run来源接通，Job来源待运行时。

完整E1策略/不可变Run快照、Job执行/恢复/三触发/人工/质量与文件/评测/旧App回调和计划切换等仍未完成。最新原始测试与真实UI技术验证见[闭环进度](../../.closed-loop/tasks/20261101-job-message/progress.md)；旧全量计数不能代替当前版本检查，27项真实业务AC未关闭。只在显式指定的两任务专属库前向迁移与测试，不重置任何已有库，不改日常forge或生产数据。


### 2026-11-01 普通用户配置表单（FR-UI-23）

本地已将Job运行限制、消息渠道请求头/凭据/提醒对象、模板变量、Provider/MCP请求头、应用权限及定时周期/输入改为可视化配置；OpenAPI/能力包以文件导入为默认入口。复用既有权限与写入契约，保留未覆盖配置和高级技术文档。真实页面保存/刷新与390px适配、控制台598项及相关系统检查证据见[配置表单验收](../../.design-evidence/2026-11-01-configuration/verification.md)。此项不代表Job执行、真实消息业务或生产验收已完成；未提交推送发布。
