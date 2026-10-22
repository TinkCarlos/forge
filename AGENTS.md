# AGENTS.md

本文件是 AI 编码代理与新成员进入 Forge 仓库的第一入口。**先读本文，再读对应契约文档，最后写代码。**

## 0. 当前状态

- 仓库已包含 **0.1.0 可运行 MVP**：MySQL、Fastify、Agent/模型/MCP/Skill/工具、运行与审批、开放 API、控制台、SSO/Connector 基础能力。
- 设计文档是 V2 目标架构；**实现与目标的差异以 [implementation-status.md](docs/05-development/implementation-status.md) 为准**。
- 当前没有 Temporal/Redis 依赖实现；运行使用 MySQL 队列 + 轮询 worker。不要把目标架构当成已实现。
- 不要凭空创建与文档冲突的表、接口、权限码或目录；需要变更时先改文档并说明理由。

## 1. 项目一句话

Forge 是公司自用的企业级 Agent 后端开发框架：私有化部署、MySQL 单一系统库、Agent/Skill/MCP/工具/模型均可插拔、统一 SSO 登录、统一开放 API、管理控制台、功能权限 + 数据权限、定时任务。目标运行时为 Temporal；当前 MVP 使用 MySQL 队列。

## 2. 必读顺序

1. 本文 `AGENTS.md`
2. [docs/README.md](docs/README.md)（文档地图）
3. [产品需求](docs/01-requirements/product-requirements.md)（找到需求编号与优先级）
4. [总体设计](docs/02-architecture/system-design.md)
5. 与任务相关的专项文档：
   - 统一登录/Connector：[sso-and-connector.md](docs/02-architecture/sso-and-connector.md)
   - 功能/数据权限：[permissions.md](docs/02-architecture/permissions.md)
   - 插件/包：[plugin-system.md](docs/02-architecture/plugin-system.md)
   - 控制台：[admin-console.md](docs/02-architecture/admin-console.md)
   - 接口：[open-platform.md](docs/03-api/open-platform.md)、[admin-api.md](docs/03-api/admin-api.md)
   - 数据：[mysql-design.md](docs/04-data/mysql-design.md)
   - 发布：[release-process.md](docs/06-operations/release-process.md)

契约冲突时：**需求 > 架构 > 接口/数据 > 代码**。先修文档，再修代码。

## 3. 目标目录（摘要）

```
apps/api          Fastify：/admin /open /integration /auth /sse /static
apps/worker       Temporal Worker：llm / http / mcp / docparse / browser / maintenance
apps/console      React 管理控制台
packages/core     类型、错误码、AgentSpec、Principal/AccessContext、Pi 适配
packages/contracts DTO、事件 Schema、OpenAPI
packages/store    Drizzle schema、Repository、迁移、QueryFilter
packages/registry 能力包/安装生命周期/作用域
packages/models   Provider/Model/Route/限流/成本
packages/capabilities 工具（内置/OpenAPI/MCP/Skill/Connector）
packages/identity OIDC/SSO、BFF 会话、角色映射、Connector、服务账号
packages/governance 功能权限、数据权限、审批、凭据、审计
packages/runtime  Temporal 工作流、Agent 循环、Schedule
packages/open-platform 应用/密钥/配额/Webhook
packages/eval     评测
packages/sdk      TS 客户端
packages/testkit  测试容器/fixtures
services/doc-parser, services/browser, services/sandbox(P2)
plugins/, examples/, deploy/, docs/, tests/, vendor/agent-connector/
```

完整规则见 [repo-layout.md](docs/05-development/repo-layout.md)。服务端包依赖方向禁止循环；SQL 只能在 `store`；对外 DTO 只能在 `contracts`。

## 4. 技术基线

| 项 | 版本/选型 |
| --- | --- |
| Node.js | 24 |
| TypeScript | strict |
| 包管理 | pnpm workspace |
| Lint/Format | Biome |
| Agent 内核 | Pi 1.3.x，仅 `core/src/pi/` 可 import |
| 工作流 | Temporal TypeScript SDK 1.25+ |
| HTTP | Fastify 5 + SSE |
| 数据库 | MySQL 8.0.30+ + Drizzle ORM（**唯一系统库**） |
| 缓存 | Redis 7 |
| 对象存储 | S3 兼容 |
| 前端 | React 19 + Vite + Ant Design 5 + TanStack Query |
| 身份 | OIDC + Agent Connector 0.2.0 |
| 测试 | Vitest、Testcontainers（真实 MySQL/Redis）、Temporal Test Server、Playwright |
| 部署 | Docker Compose（P0）、K8s/K8s（公司发布）、Helm（P1） |

## 5. 不可违反的规则

### 5.1 数据库

- 只能使用 MySQL 8.0.30+；禁止 SQLite/PostgreSQL 回退，测试也必须真实 MySQL。
- 所有表结构变更：更新 `docs/04-data/mysql-design.md` + Drizzle schema + 迁移 SQL + 测试。
- 迁移 forward-only；生产禁止 `drizzle-kit push`；先备份、人工审批、迁移 Job 执行。
- 采用 expand/contract；不要在同一个版本删列/改语义。
- ID 用 ULID（`CHAR(26) ascii_bin`）；时间 UTC `DATETIME(3)`；金额 `DECIMAL(12,6)`。
- 配置类资源带 `revision` 乐观锁；日志/事件追加写，不软删除。

### 5.2 身份与 SSO

- 所有公司 Forge 项目生产登录必须走统一 SSO（OIDC 授权码 + PKCE）；本地账号只作应急管理员。
- 生产 `SSO_MODE=required`；不得为方便关闭验签、放宽 audience/issuer/environment。
- SSO 角色只映射到 Forge 角色；**数据权限仍由 Forge 本地策略决定**。
- 会话存 Redis；Cookie HttpOnly/Secure/SameSite=Lax；变更请求带 CSRF。
- Agent Connector 接入：
  - 只允许 `vendor/agent-connector` 中经 SHA256 校验的 0.2.0 制品；禁止公共 npm/PyPI 同名包。
  - 入站只开放 `/integration/v1`；硬拒绝 `/admin`、`/open`、`/api/credentials`、`/api/keys`、`/api/secrets`、`/api/tokens`。
  - 先清除自报身份头，再验签 Principal；路径双层解码 + 规范化。
  - 配置公钥固定保存；配置版本只能递增；撤销/签名失败/环境不匹配必须失败关闭。
  - 三个开关默认 `false`；`LEGACY_FALLBACK` 固定 `false`。
  - 不记录 Client Secret/Token/私钥/完整敏感载荷；缓存按实例隔离、权限 `0600`。

### 5.3 权限

- 功能权限与数据权限都必须服务端强制执行；前端隐藏不是安全边界。
- 功能权限：权限码集中在 `packages/core/src/auth/permissions.ts`，API/菜单/操作一致；默认拒绝。
- 数据权限：默认拒绝、deny 优先；与外部 Principal `dataScope` 取交集。
- 所有 Repository 的 list/find/export 必须接收 `QueryFilter`/`AccessContext`；禁止先查全量再内存过滤。
- 详情、下载、SSE、知识库检索、导出都要二次校验；无权限统一 404。
- 新增数据资源类型时，必须同时补：策略矩阵、过滤字段、索引、测试、控制台展示。
- 组织管理员不能授予自身没有的权限或超出自身的数据范围。

### 5.4 运行时

- 上下文正文存 MySQL，不进 Temporal 历史；Activity 只传引用/摘要。
- 每次 Run 固定 Agent 版本、依赖版本、策略快照；发布新版本不影响运行中的 Run。
- 工具调用幂等键 `runId:toolCallId`；4xx 业务错误不重试，5xx/超时按策略重试。
- 高危工具审批在 Workflow 内等待信号；超时按策略；执行前再次校验权限与凭据作用域。
- 预算在模型调用前后检查；超限 `budget_exhausted`，保留部分输出。
- 取消必须幂等；状态与事件一致。
- 定时任务使用 Temporal Schedule；以服务账号身份运行；默认并发策略 `skip`；服务账号/Agent 停用即暂停。

### 5.5 插件与扩展

- 控制台上传包只能声明式；不能执行任意代码。
- 代码型扩展只允许运维安装的受信包或 MCP 服务。
- 包必须校验 manifest、checksum、路径、大小、依赖与兼容性；失败自动回滚。
- 运行固定包/资源版本；热更新只影响新 Run。
- 卸载前检查引用并排空；禁止直接删除被引用的资源。
- Connector 工具源只声明 `targetSystemId`/方法/路径/capability/dataScope，不保存目标系统密钥。

### 5.6 错误与日志

- 只能抛 `ForgeError(code, context, cause)`；错误码定义在 `packages/core/src/errors/codes.ts`。
- 每个错误码含 `code/meaning/userMessage/remedy/httpStatus/retryable/audience`。
- 新增错误码必须更新注册表、生成文档、测试；不存在的码编译期失败。
- 每个错误只在最外层边界记录一次；日志固定字段；密钥/Token/Cookie 脱敏。
- API 错误响应统一 `{ error: { code, message, requestId, details, remedy } }`。

### 5.7 接口与文档

- 所有对外 DTO 在 `contracts`；管理/开放/集成 API 由代码生成 OpenAPI 3.1。
- 接口变更同时更新：`docs/03-api/*`、`contracts`、OpenAPI、SDK、契约测试。
- 数据变更同时更新：`docs/04-data/mysql-design.md`、schema、迁移、数据字典。
- 需求变更先改需求编号与验收口径；PR/提交引用需求编号。
- 文档链接用相对路径；示例不得含真实密钥。
- 不新增“临时接口”绕过治理；不把管理 API 暴露给 Connector。

### 5.8 发布

- 遵循 [release-process.md](docs/06-operations/release-process.md) 与公司 K8s/CI/Nginx 上游文档。
- 生产只部署带时间戳 + commit 的镜像 tag；记录 digest；不使用 `latest`。
- 迁移先于滚动；备份、人工审批、回归；破坏性清理延后一个版本。
- 首次部署/重大变更 SSO/Connector 开关默认关闭，验收后灰度。
- 发布记录必须含：git SHA、镜像 digest、迁移版本、SSO/Connector 状态、回滚镜像、审批人。

## 6. 开发配方

### 6.1 新增一个 API 端点

1. 在需求文档找到/新增需求编号。
2. 在 `contracts` 定义请求/响应 Schema。
3. 在 `docs/03-api` 更新接口与错误。
4. 在 `apps/api` 路由中：认证 → 权限 → 校验 → 调领域服务。
5. 若涉及数据，Repository 接收 `AccessContext`/`QueryFilter`。
6. 加 controller/service/repository 测试 + 契约测试。
7. 生成 OpenAPI，检查 diff。

### 6.2 新增一张表 / 改字段

1. 更新 `mysql-design.md`（用途、字段、索引、保留）。
2. 修改 `packages/store/src/schema`。
3. `pnpm db:generate` 生成迁移，人工审查 SQL。
4. 迁移必须从空库可执行、幂等、向后兼容。
5. 更新 Repository 与测试；必要时补种子/回填。
6. 执行集成测试（Testcontainers MySQL）。
7. 更新数据字典与保留策略。

### 6.3 新增功能权限

1. 在 `permissions.ts` 加权限码（domain.action）。
2. 在 `permissions` 种子与 `docs` 权限目录同步。
3. 在 API/菜单/操作上声明并测试。
4. 更新内置角色模板；确认不误授。
5. 控制台 `PermissionGate` 与页面测试。

### 6.4 新增数据权限资源类型

1. 在 `permissions.md` 定义资源、动作、范围、owner 字段。
2. 在 `data_policies`/策略矩阵中加入。
3. Repository 实现 `QueryFilter`；详情/导出/下载/SSE 二次校验。
4. 加跨组织、self、deny、API App、服务账号测试。
5. 控制台权限页与预览支持。

### 6.5 新增工具源（OpenAPI / Connector）

1. 在 `capabilities` 注册 source 类型与执行器。
2. OpenAPI：解析 → 操作 → 工具 → 鉴权 → 风险 → 测试。
3. Connector：`targetSystemId`、方法/路径、capability、dataScope；经 `callSystem`。
4. 大结果写对象存储；超时/重试/幂等；SSRF/网络策略。
5. 更新 `docs/03-api`、控制台测试台、风险策略与测试。

### 6.6 新增模型 Provider

1. 内置协议走 `models` 适配器；自定义优先 OpenAI-compatible。
2. 配置项：baseUrl、auth secret、headers、timeout、TLS、能力、价格。
3. 连接测试、模型发现、能力校验、路由/fallback、限流。
4. 不支持的参数透传要告警；能力不匹配在发布/运行前拦截。
5. 非标准协议代码适配器只允许运维安装（P2），控制台不提供上传入口。

### 6.7 新增插件资源类型

1. 更新 manifest schema 与包校验。
2. 定义资源版本、依赖、作用域、安装步骤、回滚。
3. 更新 `registry`、`store`、安装 API、控制台向导。
4. 加合法/非法包、升级/回滚/卸载保护、热更新测试。
5. 更新插件文档与示例包。

### 6.8 新增控制台页面

1. 在 `admin-console.md` 定义路由、动作、状态、权限。
2. 页面薄、逻辑放 `features/*/hooks`；用生成的 API client。
3. 覆盖空/加载/错误/无权限/边界状态。
4. 加 Playwright 关键路径与 axe 检查。
5. 更新导航与 i18n key。

### 6.9 新增定时任务能力

1. 通过 Temporal Schedule API，不自研调度器。
2. 服务账号 + 版本策略 + 并发策略 + 输入 Schema。
3. 写库与 Temporal 一致性；失败回写错误并保持停用。
4. 权限 `schedule.*`；审计；失败通知。
5. 测试触发、并发 skip、停用暂停、时区/DST。

## 7. 测试与完成定义

### 7.1 必跑

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:contract
pnpm build
pnpm smoke
pnpm smoke:sso
```

涉及 UI：手动浏览器验收（当前无 Playwright）；涉及迁移：从空库执行 + 回滚/兼容测试；涉及 SSO/Connector：`pnpm smoke:sso`（Mock IdP + Principal 验签）；涉及权限：`pnpm test` + `pnpm smoke`。

### 7.2 完成定义（DoD）

- [ ] 需求编号与验收口径已实现。
- [ ] 单元/集成/契约测试通过；关键路径 E2E。
- [ ] 错误码、日志、审计、指标齐全。
- [ ] 权限（功能 + 数据）在服务端强制；无越权路径。
- [ ] 迁移从空库可执行、向后兼容、有备份说明。
- [ ] 文档/OpenAPI/数据字典/SDK 同步。
- [ ] 无明文密钥、无跳过校验、无 `any`、无未处理 Promise。
- [ ] 性能无明显退化；列表查询走索引。
- [ ] 发布/回滚步骤可执行。

## 8. 文档同步矩阵

| 变更 | 必须更新 |
| --- | --- |
| API/DTO/事件 | `docs/03-api/*`、`contracts`、OpenAPI、SDK、contract tests |
| 表/索引/保留 | `docs/04-data/mysql-design.md`、Drizzle schema、迁移、Repository 测试 |
| 权限码/角色/数据范围 | `docs/02-architecture/permissions.md`、种子、API、控制台、矩阵测试 |
| SSO/Connector | `docs/02-architecture/sso-and-connector.md`、环境变量、验收清单 |
| 插件格式/生命周期 | `docs/02-architecture/plugin-system.md`、registry、安装向导、fixtures |
| 运行时/审批/预算/定时 | `docs/02-architecture/system-design.md`、工作流测试 |
| 部署/发布 | `docs/06-operations/*`、K8s/Compose、发布记录模板 |
| 需求/阶段 | `docs/01-requirements/product-requirements.md` |

## 9. 代码风格

- TypeScript strict；禁止 `any`（边界用 Zod/TypeBox 推导）。
- 命名导出；文件 kebab-case；类型 PascalCase；常量 UPPER_SNAKE。
- 只写必要的注释，解释“为什么”，不解释“是什么”。
- 不引入新依赖除非必要；引入前说明用途、许可证、维护状态。
- 所有外部输入在边界校验；内部信任类型。
- 日期/金额/ID 使用统一工具函数；不手写格式。
- 不在日志/错误消息中拼接敏感数据。
- 事务短小；外部调用不在事务内；先写状态再调用外部，幂等补偿。

## 10. 禁止事项

- 用 SQLite/PostgreSQL 作为开发或测试回退。
- 在生产关闭 SSO、验签、CSRF、数据权限过滤。
- 从公共源安装 Agent Connector 或伪造其制品。
- 让 Connector 入站访问 `/admin`/`/open`/凭据路径。
- 在控制台/管理 API/日志中返回密钥明文。
- 绕过 `AccessContext` 直接查库或先查全量再过滤。
- 修改已发布 Agent/Skill 版本内容；运行中改变依赖版本。
- 在生产使用 `latest`、自动迁移、手工改表。
- 新增表/接口不更新文档与 contracts。
- 把管理端/内部接口当作对外稳定契约；对外只承诺 `/open/v1`。

## 11. 第三方接入参数与实现默认（不阻塞开发）

以下已决策，不需要等待第三方确认后再开发：

1. **外部参数**：System ID、Connector ID、OIDC issuer/clientId/audience、配置公钥、角色 code/name、出站 grant 由 Agent 管理员在部署时提供；代码只接受配置，不写死环境值。
2. **令牌校验**：同时实现标准 OIDC 与 Agent Principal 两条路径；`SSO_TOKEN_VALIDATION_MODE=oidc|agent-principal|both`，默认 `oidc`；`id_token` 始终按 OIDC 校验，`agent-principal` 额外验签 `access_token` 并校验 `sub` 对齐。
3. **角色映射**：必须显式配置；映射为空拒绝登录（`SSO-1201`），由应急管理员先初始化；禁止按角色 code 自动授权。
4. **组织归属**：默认本地分配，不从邮箱域名推断；未分配组织只有 `self` 数据范围。
5. **Connector 开关**：未拿到三方参数时保持 `AGENT_CONNECTOR_ENABLED/INBOUND/OUTBOUND=false`；开发/测试用 Mock IdP 与 contract vectors。
6. **P0 范围**：Webhook、同步便捷调用、`custom_orgs`、定时任务、SSO/Connector 骨架、功能权限矩阵、行级数据权限、服务账号。英文、字段脱敏、资源共享、知识库、评测、SDK/Thread API 放 P1。
7. **发布**：P0 代码验收可用 Mock IdP；生产上线前必须完成真实 SSO/Connector 联调，未通过不得开放生产登录/入站/出站。

详细参数清单见 [sso-and-connector.md](docs/02-architecture/sso-and-connector.md) 第 10 节。

## 12. 常用链接

- 实现状态：[docs/05-development/implementation-status.md](docs/05-development/implementation-status.md)
- 需求索引：[docs/01-requirements/product-requirements.md](docs/01-requirements/product-requirements.md)
- 文档地图：[docs/README.md](docs/README.md)
- 仓库结构：[docs/05-development/repo-layout.md](docs/05-development/repo-layout.md)
- 发布流程：[docs/06-operations/release-process.md](docs/06-operations/release-process.md)
- 部署运维：[docs/06-operations/deployment.md](docs/06-operations/deployment.md)
- SSO/Connector：[docs/02-architecture/sso-and-connector.md](docs/02-architecture/sso-and-connector.md)
- 权限：[docs/02-architecture/permissions.md](docs/02-architecture/permissions.md)
