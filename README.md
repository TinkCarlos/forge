# Forge

面向企业私有化部署的通用 Agent 后端开发框架。当前仓库已包含一个**可运行的 0.1.0 MVP**：MySQL + Fastify + 可插拔 Agent/Skill/MCP/工具/模型 + 管理控制台 + 开放 API + 审批 + 定时任务 + SSO/Connector 基础能力。

> 设计文档仍是 V2 目标架构；实际实现与目标的差异见 [实现状态](docs/05-development/implementation-status.md)。

## 快速开始

### 1. 依赖

- Node.js 22+
- MySQL 8.0.30+（**唯一系统库**，测试也必须用 MySQL）
- 可选：远程/本地 HTTP MCP 服务、OpenAI-compatible 模型端点

### 2. 初始化

```bash
pnpm install
cp .env.example .env
# 修改 .env 中的 DATABASE_URL、管理员密码、FORGE_MASTER_KEY
pnpm db:migrate
pnpm db:seed
pnpm dev
```

打开 http://localhost:3100 ，使用 `.env` 中的 `FORGE_ADMIN_EMAIL` / `FORGE_ADMIN_PASSWORD` 登录（默认 `admin@forge.local` / `change-me-now`，请立即修改）。

数据库不存在时先创建：

```sql
CREATE DATABASE forge CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'forge'@'localhost' IDENTIFIED BY 'forge_dev_password';
GRANT ALL PRIVILEGES ON forge.* TO 'forge'@'localhost';
```

### 3. 立即体验

1. 控制台「Agents」→「试运行」内置 `demo-agent`（使用离线 Mock 模型，无需 API Key）。
2. 「模型」→ 添加自定义 OpenAI-compatible Provider 与模型，然后在 Agent spec 中引用。
3. 「能力包」→ 粘贴声明式 JSON，一次性安装 Agent / Skill / MCP / Provider。
4. 需要演示 MCP/OpenAPI 工具时：`pnpm mock:services`（端口 8090），然后在「MCP 服务」添加 `http://127.0.0.1:8090/mcp`，或在「工具源」导入 `http://127.0.0.1:8090/api/openapi.json`。
   本地 OpenAPI 指向 127.0.0.1，需要在 `.env` 中临时设置 `TOOL_ALLOW_PRIVATE_NETWORK=true`（生产保持 `false`）。

### 4. 开放 API

控制台「应用与密钥」创建应用和 API Key，然后：

```bash
curl -X POST "http://localhost:3100/open/v1/agents/mcp-agent/runs" \
  -H "Authorization: Bearer fsk_..." \
  -H "Content-Type: application/json" \
  -d '{"input":{"text":"你好"}}'
```

支持：Agent 目录、异步 Run、SSE 事件、结果、取消、应用配额、Webhook、API Key Scope。

### 5. 验证

```bash
pnpm typecheck
pnpm test          # 单元 + 真实 MySQL 集成测试
pnpm smoke         # 端到端：MCP、审批、OpenAPI、定时任务、开放 API、数据权限、能力包
pnpm smoke:edit    # 编辑流程：Agent 新版本、MCP/Skill/模型/应用/定时任务修改
pnpm smoke:sso     # Mock OIDC + Agent Principal 验签
```

`pnpm smoke` 需要 API 在 `http://127.0.0.1:3100` 运行；MCP/OpenAPI 用例需要先运行 `pnpm mock:services`。

## 已实现（0.1.0）

- **Agent**：创建、草稿/发布版本、试运行、开放 API、启停、包安装。
- **模型**：内置离线 Mock；任意 OpenAI-compatible Provider/模型；测试连接；AES-256-GCM 加密密钥。
- **MCP**：HTTP Streamable MCP 初始化、工具发现、工具调用、风险分级。
- **工具**：OpenAPI 3.x 导入、工具生成、HTTP 调用、SSRF 默认防护。
- **Skill**：SKILL.md 创建/发布/新版本，注入 Agent 上下文。
- **运行**：MySQL 持久化队列、Agent 工具循环、消息/工具调用/事件、SSE、取消、最大步数、成本上限、结构化输出校验。
- **审批**：高风险 MCP 工具暂停 Run，控制台批准/驳回后恢复。
- **定时任务**：Cron + 时区、启停、立即运行、下次运行时间。
- **开放平台**：应用、API Key（哈希存储）、Scope、每分钟/每日配额、Run/SSE/结果/取消、Webhook 签名。
- **身份**：本地管理员；OIDC 授权码 + PKCE + JWKS；Agent Connector Principal 验签与主体映射；SSO 角色映射。
- **权限**：角色功能权限、用户数据范围（all/org/self/app）、Repository 层过滤、审计日志。
- **控制台**：Agent/模型/MCP/Skill/工具源/能力包/运行/审批/定时任务/应用/用户/SSO 页面，支持新增与修改。
- **能力包**：声明式 JSON 安装 Agent/Skill/MCP/Provider，记录安装与卸载。

## 尚未实现（目标架构 P1/P2）

- Temporal 持久化工作流（当前是 MySQL 队列 + 轮询 worker；崩溃恢复能力有限）。
- Redis SSE/限流/会话共享（当前单实例内存会话 + DB 事件轮询）。
- MCP stdio 进程管理、远程 OAuth。
- Agent Connector 的签名配置刷新/LKG/心跳/出站 `callSystem`（当前已实现 Principal 验签与入站主体映射）。
- 文件上传/OCR/文档解析、Artifact、知识库/RAG、评测中心、字段级脱敏、资源共享、Helm/离线包。
- Drizzle ORM（当前 `packages/store` 使用 mysql2 + 手写 SQL，表结构以 [MySQL 设计](docs/04-data/mysql-design.md) 为目标）。

## 目录

```
apps/api                  Fastify：管理/开放/集成/SSE/控制台静态
apps/worker               可独立运行的后台 worker（默认 API 内嵌 worker）
apps/console/public       无构建依赖的管理控制台
packages/core             类型、配置、权限、加密、错误
packages/store            MySQL schema、迁移、Repository
packages/identity         本地登录、OIDC、Connector Principal、会话
packages/governance       功能/数据权限、Run 过滤
packages/models           OpenAI-compatible / Mock 适配
packages/capabilities     MCP、OpenAPI、内置工具、Skill 上下文
packages/runtime          Run 循环、审批恢复、调度、Webhook
services/mock-mcp         演示 MCP/OpenAPI 服务
docs/                     需求、架构、接口、数据、开发、运维
```

## 设计文档

| 文档 | 说明 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | AI 编码代理入口 |
| [docs/README.md](docs/README.md) | 文档地图 |
| [产品需求](docs/01-requirements/product-requirements.md) | 全量需求与路线图 |
| [总体设计](docs/02-architecture/system-design.md) | 目标架构 |
| [插件系统](docs/02-architecture/plugin-system.md) | 能力包与热插拔 |
| [管理控制台](docs/02-architecture/admin-console.md) | 页面与流程 |
| [SSO/Connector](docs/02-architecture/sso-and-connector.md) | 统一登录与接入 |
| [权限](docs/02-architecture/permissions.md) | 功能/数据权限 |
| [开放 API](docs/03-api/open-platform.md) | 对外接口 |
| [MySQL 设计](docs/04-data/mysql-design.md) | 数据模型 |
| [部署](docs/06-operations/deployment.md) / [发布](docs/06-operations/release-process.md) | 运维与发布 |
| [实现状态](docs/05-development/implementation-status.md) | 已实现/未实现清单与验证记录 |
