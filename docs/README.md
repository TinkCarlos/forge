# Forge 文档中心

本目录是 Forge 的**契约来源**。代码实现必须与这里的需求、接口、数据设计一致；发生冲突时，先改文档并在评审中确认，再改代码。

## 1. 文档地图

| 目录 | 文档 | 内容 | 主要读者 |
| --- | --- | --- | --- |
| `01-requirements` | [product-requirements.md](01-requirements/product-requirements.md) | 目标、角色、功能需求编号、非功能需求、验收、路线图 | 产品、架构、开发、AI |
| `02-architecture` | [system-design.md](02-architecture/system-design.md) | 总体架构、模块、运行流程、治理、安全、测试 | 架构、后端、AI |
| | [plugin-system.md](02-architecture/plugin-system.md) | 包格式、安装生命周期、热插拔、作用域、隔离 | 后端、插件作者、AI |
| | [admin-console.md](02-architecture/admin-console.md) | 控制台信息架构、页面、关键流程、前端规范 | 前端、产品、AI |
| | [sso-and-connector.md](02-architecture/sso-and-connector.md) | 统一登录、OIDC、角色映射、Agent Connector 入站/出站 | 后端、安全、交付、AI |
| | [permissions.md](02-architecture/permissions.md) | 功能权限、角色矩阵、数据权限、行级过滤、服务账号 | 后端、安全、产品、AI |
| `03-api` | [open-platform.md](03-api/open-platform.md) | 统一开放平台：鉴权、Run、SSE、Webhook、配额 | 外部开发者、后端、AI |
| | [admin-api.md](03-api/admin-api.md) | 管理端 API 资源面、约定、权限 | 前端、后端、AI |
| `04-data` | [mysql-design.md](04-data/mysql-design.md) | MySQL 表字典、DDL、索引、分区、迁移、备份 | 后端、DBA、AI |
| `05-development` | [repo-layout.md](05-development/repo-layout.md) | 目标目录、包职责、依赖规则、构建发布 | 开发、AI |
| | [implementation-status.md](05-development/implementation-status.md) | 已实现/未实现清单、验证证据、与目标架构差异 | 开发、AI、评审 |
| `06-operations` | [deployment.md](06-operations/deployment.md) | 部署拓扑、环境变量、升级、备份、排障 | 运维、交付、AI |
| | [release-process.md](06-operations/release-process.md) | 公司 K8s/CI/Nginx 发布规范、迁移与 SSO/Connector 闸门 | 运维、交付、AI |
| 根目录 | [AGENTS.md](../AGENTS.md) | AI 开发入口、命令、禁止事项、开发配方 | AI、新成员 |
| 历史 | [V1 设计](superpowers/specs/2026-10-21-forge-agent-framework-design.md) | 初版设计，仅追溯 | 所有人 |

## 2. 阅读路径

**产品 / 新成员**
1. 根目录 `README.md`
2. 需求文档第 1–4 章
3. 总体设计第 2–6 章
4. 控制台文档第 2–3 章

**后端开发 / AI 编码代理**
1. `AGENTS.md`
2. 需求文档中对应需求编号
3. 总体设计
4. 接口文档 + MySQL 设计
5. 插件文档（涉及扩展点时）
6. 统一登录与权限文档（涉及身份/授权时）

**安全 / 交付 / 运维**
1. SSO 与 Connector
2. 功能权限与数据权限
3. 部署与发布流程

**接入方 / 外部开发者**
1. 开放平台 API
2. 控制台「开放平台」页（由管理员创建应用与密钥）
3. 错误模型与配额章节

**插件作者**
1. 插件系统
2. 仓库目录中的 `plugins/` 约定
3. 管理 API 中 package / installation 接口

## 3. 需求编号规则

| 前缀 | 领域 |
| --- | --- |
| `FR-AG` | Agent 构建与运行 |
| `FR-PL` | 插件化与资源管理 |
| `FR-MCP` | MCP 接入 |
| `FR-SK` | Skill 管理 |
| `FR-MD` | 模型接入与路由 |
| `FR-TL` | 工具与连接器 |
| `FR-UI` | 管理控制台 |
| `FR-OP` | 统一开放平台 |
| `FR-GV` | 治理、权限、审批、审计 |
| `FR-RT` | 运行时 |
| `FR-FL` | 文件、文档、Artifact |
| `FR-KB` | 知识库与记忆 |
| `FR-TR` | 触发器与集成 |
| `FR-EV` | 评测 |
| `FR-OB` | 可观测与通知 |
| `FR-DLV` | 交付、SSO 发布闸门、发布规范 |
| `NFR` | 非功能需求 |

优先级：`P0` 首个可交付版本；`P1` 平台化增强；`P2` 生态与规模化。P2 不代表不重要，只表示不阻塞首版。

## 4. 契约维护规则

1. **接口变更**：同时更新 `03-api/*.md`、`packages/contracts`、生成的 OpenAPI、SDK 与契约测试。
2. **数据变更**：同时更新 `04-data/mysql-design.md`、Drizzle schema、迁移 SQL 与数据字典。
3. **需求变更**：先改需求编号与验收口径，再改架构/接口/代码；PR 必须引用需求编号。
4. **错误码变更**：只改错误码注册表，重新生成 `docs/reference/error-codes.md`（脚手架建立后生成），不得手写散落错误码。
5. **权限变更**：同时更新 `02-architecture/permissions.md`、权限种子、API/菜单、矩阵测试与审计。
6. **SSO/Connector 变更**：同时更新 `02-architecture/sso-and-connector.md`、环境变量、验收清单与发布流程。
7. **发布流程变更**：同时更新 `06-operations/release-process.md` 与上游 K8s/CI/Nginx 文档映射。
8. **文档链接**：使用相对路径；跨文档引用章节时写标题，避免只写编号。
9. **图与代码块**：架构图用 ASCII 或 Mermaid；示例必须可被复制执行（密钥用占位符）。

## 5. 术语表

| 术语 | 含义 |
| --- | --- |
| Agent | 可版本化的智能体定义：模型策略 + 指令 + 技能 + 工具集 + 限制 + 输出契约 |
| Agent Pack | 可安装的 Agent 能力包，可携带 Prompt、Skill、工具声明、MCP 配置 |
| Skill | 遵循 `SKILL.md` 的指令型能力包，可含资源文件；脚本能力必须显式声明 |
| MCP | Model Context Protocol 服务，通过 stdio / Streamable HTTP 提供工具 |
| Tool | 模型可调用的原子能力，来源为内置、OpenAPI、MCP、插件 |
| Plugin / Package | 统一安装包，类型可为 agent / skill / mcp / tool / provider / mixed |
| Installation | 某个包版本在某个作用域内的一次安装实例 |
| Run | 一次 Agent 执行，Temporal 工作流承载，状态持久化 |
| Thread | 多轮会话容器，跨 Run 保存消息 |
| Policy Snapshot | Run 启动时冻结的权限、工具、模型、预算快照 |
| API App | 开放平台调用方应用，持有密钥、Scope、配额与 Webhook |
| Console | Forge 管理控制台，面向管理员、构建者、审批人 |
| SSO | 统一登录；公司默认由 Agent 平台 IdP 提供 OIDC |
| Agent Connector | 公司 Agent 平台的跨系统接入 SDK/协议（0.2.0），负责配置、心跳、Principal 验签与 `callSystem` |
| Service Account | 服务账号；定时任务与系统集成使用的机器身份，独立角色与数据范围 |
| Data Scope | 数据范围；决定用户在功能内能访问哪些行级数据（组织、本人、应用等） |
| Schedule | 定时任务；由 Temporal Schedule 驱动，以服务账号身份运行 Agent |
| Pi | Agent 内核依赖（`@earendil-works/pi-ai`、`pi-mcp`），被适配层隔离 |
