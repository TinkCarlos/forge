# Forge 仓库目录与工程规范

版本：1.0　日期：2026-10-21　状态：目标结构；0.1.0 实际差异见 [implementation-status.md](implementation-status.md)

## 1. 目标结构

```
forge/
├── AGENTS.md                     AI 开发入口
├── README.md
├── package.json                  workspace 根；scripts 统一入口
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json                    lint + format
├── .env.example                  仅占位符，不含真实密钥
├── apps/
│   ├── api/                      Fastify：/admin /open /integration /auth /sse /static
│   ├── worker/                   Temporal Worker：llm / http / mcp / docparse / browser / maintenance
│   └── console/                  React 管理控制台
├── packages/
│   ├── core/                     类型、错误码、AgentSpec、Principal/AccessContext、Pi 适配层
│   ├── contracts/                管理/开放/集成 API DTO、事件 Schema、OpenAPI 源
│   ├── store/                    Drizzle schema、Repository、迁移、事务、QueryFilter
│   ├── registry/                 能力包、安装生命周期、资源目录、版本解析
│   ├── models/                   Provider 适配、模型目录、路由、限流、用量与成本
│   ├── capabilities/             工具注册表（内置/OpenAPI/MCP/Skill/Connector）、执行器
│   ├── identity/                 OIDC/SSO、BFF 会话、JIT 用户、角色映射、Agent Connector、服务账号
│   ├── governance/               功能权限、数据权限、策略快照、风险、审批、凭据、审计
│   ├── runtime/                  Workflow、Activity、Agent 循环、上下文、事件、Schedule
│   ├── open-platform/            应用/密钥/Scope/配额/Webhook/公开 API
│   ├── eval/                     数据集、评测运行器
│   ├── sdk/                      TypeScript 客户端 + SSE/Webhook 验签
│   └── testkit/                  Testcontainers、Faux Provider、权限/包 fixtures
├── services/
│   ├── doc-parser/               Python FastMCP：PDF/OCR/Office
│   ├── browser/                  Playwright MCP
│   └── sandbox/                  P2 代码执行隔离
├── plugins/
│   ├── agents/                   内置/示例 Agent 包
│   ├── skills/                   内置/示例 Skill
│   ├── mcp/                      内置 MCP 配置
│   ├── tools/                    OpenAPI/Connector 工具包
│   └── providers/                Provider 配置包
├── examples/
│   ├── contract-reviewer/        完整 mixed 包示例
│   └── custom-model/             自定义 OpenAI-compatible 配置示例
├── deploy/
│   ├── compose/                  P0 单机编排
│   ├── k8s/                      Deployment/Service/PVC/Secret 模板
│   ├── helm/                     P1
│   └── images/                   基础镜像与离线包
├── docs/                         需求/架构/接口/数据/运维（见 docs/README.md）
├── scripts/                      迁移、备份、种子、发布辅助
├── tests/
│   ├── contract/                 OpenAPI/事件/SDK 契约测试
│   ├── e2e/                      Playwright
│   ├── load/                     k6
│   └── fixtures/                 包、SSO/Connector、权限矩阵数据
└── vendor/
    └── agent-connector/          Agent Connector 0.2.0 内部制品（校验 SHA256 后提交）
```

> `vendor/agent-connector/` 只存放公司内部发布的 SDK 制品；不得从公共 npm/PyPI 拉取同名包。制品校验值见 [sso-and-connector.md](../02-architecture/sso-and-connector.md)。

## 2. 包职责

| 包 | 负责 | 不负责 |
| --- | --- | --- |
| `core` | 领域类型、错误码、配置 Schema、Principal/AccessContext、Pi 适配接口 | 数据库、HTTP、业务编排 |
| `contracts` | 所有对外 DTO/事件 Schema、OpenAPI 源、错误响应类型 | 领域逻辑、SQL |
| `store` | Drizzle schema、迁移、Repository、QueryFilter、事务 | 权限判断、业务规则 |
| `registry` | 包解析、安装/升级/回滚、作用域解析、资源版本 | 模型调用、工具执行 |
| `models` | Provider 适配、能力校验、路由、限流、成本 | Agent 循环、工具执行 |
| `capabilities` | 工具注册、Schema、执行器、结果截断/对象存储 | 权限决策、审批等待 |
| `identity` | OIDC/SSO、会话、JIT、角色映射、Connector Runtime、Principal 解析 | 数据权限、业务授权 |
| `governance` | 权限目录、角色、数据策略、AccessContext、审批、凭据、审计 | HTTP 路由、模型调用 |
| `runtime` | Temporal 工作流、Activity、Agent 循环、上下文、事件、Schedule | 直接 SQL、UI |
| `open-platform` | App/Key/Scope/配额/Webhook、公开 API 服务 | 管理端配置、Agent 执行 |
| `eval` | 数据集、评测运行、评分 | 生产运行路径 |
| `sdk` | TS 客户端、SSE、Webhook 验签 | 服务端逻辑 |
| `testkit` | 测试容器、Faux Provider、fixtures | 生产依赖 |

## 3. 依赖规则

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

- **禁止循环依赖**；用 `dependency-cruiser` 在 CI 检查。
- `core` 不 import 任何其他内部包；Pi 只允许在 `core/src/pi/` 出现。
- 所有 SQL 只在 `store`；其他包依赖 Repository 接口，不直接持有数据库连接。
- 所有对外 DTO 只在 `contracts`；控制台、SDK、测试共用生成类型。
- `identity` 与 `governance` 不互相依赖；由 `apps/api` 组合（认证 → Principal → AccessContext）。
- `runtime` 可依赖 `governance`/`capabilities`/`models`/`registry`，但不得依赖 `apps/*`。
- 跨包引用使用 `@forge/*` 包名，不使用 `../../` 深层相对路径。

## 4. 应用

### 4.1 `apps/api`

```
src/
├── main.ts                 启动、配置、优雅退出
├── app.ts                  Fastify 实例与插件注册
├── routes/
│   ├── auth.ts             /auth/login /auth/callback /auth/logout
│   ├── admin/              /admin/v1/*
│   ├── open/               /open/v1/*
│   ├── integration/        /integration/v1/*（Connector 入站）
│   └── health.ts           /healthz /readyz /metrics
├── plugins/                鉴权、CSRF、请求 ID、审计、限流、错误处理
└── workers/                Outbox Dispatcher、Webhook 投递器入口（或独立 worker）
```

- 路由只做校验、鉴权、调用领域服务；不写 SQL、不拼权限条件。
- 所有响应 DTO 使用 `contracts`；错误统一 `ForgeError`。
- 管理/开放/集成 API 分别使用独立认证插件，互不复用 Cookie/Key。
- SSE 端点关闭代理缓冲，支持 `Last-Event-ID`。

### 4.2 `apps/worker`

```
src/
├── main.ts                 连接 Temporal、注册 Worker
├── queues.ts               队列名与并发配置
├── workflows/              AgentRunWorkflow、PackageInstallWorkflow、MaintenanceWorkflow
└── activities/             prepareContext/callModel/executeTool/...、Schedule 触发
```

- 按队列拆分部署：`llm`、`http`、`mcp`、`docparse`、`browser`、`maintenance`。
- Worker 不接收外部 HTTP；配置由环境变量注入。
- 所有 Activity 幂等、可重试；大结果写对象存储。
- Connector 出站只通过 `capabilities` 的 ConnectorToolSource；不直连。

### 4.3 `apps/console`

```
src/
├── app/                    router、providers、layout、auth
├── pages/                  路由级页面（薄）
├── features/               领域组件与 hooks
│   ├── agents/ skills/ mcp/ tools/ models/
│   ├── runs/ approvals/ schedules/
│   ├── open-platform/ org/ roles/ permissions/ service-accounts/
│   └── settings/sso-connector/
├── components/              通用组件
├── lib/                     api client、query keys、SSE、i18n
└── styles/                 theme、tokens
```

- 服务端状态用 TanStack Query；不引入全局 store 存业务数据。
- 页面、流程与组件规范见 [admin-console.md](../02-architecture/admin-console.md)。

## 5. 服务

| 服务 | 语言 | 接口 | 说明 |
| --- | --- | --- | --- |
| `doc-parser` | Python 3.12 + FastMCP | MCP | 文档解析、OCR；可替换 Docling/MinerU |
| `browser` | Node/Python + Playwright | MCP | 网页读取；严格并发与网络策略 |
| `sandbox` | P2 | 内部 API/MCP | 代码执行隔离；不与 Worker 共进程 |

服务只通过 MCP/HTTP 与主框架交互；不直接访问 MySQL 业务库。凭据由主框架注入或服务自身 Secret 管理，二者择一并在接入文档中声明。

## 6. 能力包与示例

- `plugins/` 存放随框架发布的内置/示例包源码；`examples/` 存放完整交付示例。
- 包必须包含 `forge.plugin.json`、checksums、配置 Schema；规则见 [plugin-system.md](../02-architecture/plugin-system.md)。
- 公司内部跨系统工具包优先使用 `type: connector`；客户私有化可用 OpenAPI 直连。
- `vendor/` 只放经校验的内部 SDK/制品；禁止提交真实凭据。

## 7. 测试目录

| 目录 | 内容 |
| --- | --- |
| `tests/contract` | OpenAPI diff、SSE/Webhook 事件 Schema、SDK 生成 |
| `tests/e2e` | 登录、安装、发布、运行、审批、权限、定时任务 |
| `tests/load` | 50 并发用户、200 Run/h、SSE 连接 |
| `tests/fixtures` | 合法/非法包、SSO Principal、权限矩阵、组织树 |
| 包内 `*.test.ts` | 单元/集成；真实 MySQL/Redis（Testcontainers） |

## 8. 工程命令（目标）

> 脚手架建立后生效；当前仓库只有文档。

```bash
pnpm install
pnpm dev                 # api + worker + console
pnpm build
pnpm lint
pnpm typecheck
pnpm test                # unit
pnpm test:integration    # Testcontainers MySQL/Redis
pnpm test:contract
pnpm test:e2e
pnpm db:generate         # Drizzle Kit 生成迁移 SQL
pnpm db:migrate          # 迁移 Job 使用；生产人工审批
pnpm db:seed             # 权限/角色种子，幂等
pnpm pack:example        # 打包示例能力包
docker compose -f deploy/compose/docker-compose.dev.yml up -d
```

## 9. 命名与配置

- 包名 `@forge/<name>`；目录 kebab-case；导出使用命名导出。
- 环境变量统一 `FORGE_*` 前缀；SSO/Connector 使用既有 `AGENT_*`/`SSO_*` 变量。
- 配置读取集中在 `apps/*/config.ts`，用 Zod 校验；启动失败即退出，不静默使用默认值。
- 时间 UTC、ID ULID、金额 USD；展示层再本地化。
- 日志字段与错误码遵循 [system-design.md](../02-architecture/system-design.md) 第 14 节。

## 10. CI 与发布

- CI：lint → typecheck → unit → integration → contract → build；夜间 e2e/load/golden eval。
- 镜像 tag：`YYYYMMDDHHmm-<gitSHA8>`；推送 镜像仓库；记录 digest。
- 发布：遵循 [release-process.md](../06-operations/release-process.md) 与公司上游 K8s/CI/Nginx 文档。
- 数据库迁移只通过迁移 Job；禁止 `drizzle-kit push` 到生产。
- 发布前检查 SSO/Connector 开关、迁移兼容、权限种子、回滚镜像。

## 11. 新增模块的判定

只有在满足以下条件时才新增 `packages/*`：
1. 有独立且稳定的领域边界；
2. 至少被两个应用/包使用，或需要独立测试/发布；
3. 不引入循环依赖；
4. 有明确 owner 与文档。

否则优先放在现有包内，避免过度拆分。

## 12. 禁止事项

- 在 `apps/*` 直接写 SQL 或绕过 Repository/AccessContext。
- 在 `core` 之外 import Pi。
- 从公共 npm/PyPI 安装 `@your-org/agent-connector` 同名包。
- 提交真实 Secret、Connector 缓存、Token、私钥。
- 在生产使用 `latest` 镜像或自动跑迁移。
- 修改已发布 Agent/Skill 版本内容。
- 通过前端隐藏代替服务端鉴权。
- 新增表/接口不更新 `docs/04-data`、`docs/03-api` 与 `contracts`。
