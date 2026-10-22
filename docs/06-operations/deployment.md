# Forge 部署与运维

版本：1.0　日期：2026-10-21　状态：待评审

> 发布执行以 [release-process.md](release-process.md) 与公司 K8s/CI/Nginx 上游文档为准。本文描述部署拓扑、配置项与日常运维。

## 1. 部署形态

| 形态 | 用途 | 组件 |
| --- | --- | --- |
| Docker Compose（P0） | 单客户单机/小规模 | MySQL、Redis、Temporal、MinIO、API、Worker、doc-parser、browser |
| Kubernetes（P1） | 生产 HA/公司 K8s | API/Worker/Console 静态、MySQL（托管 MySQL）、Redis、Temporal、COS/共享存储 |
| 离线包（P1） | 无公网私有化 | 镜像 tar、依赖包、能力包、示例配置 |

公司内部项目使用 K8s + 统一 Nginx + CI/镜像仓库 流程，见 [release-process.md](release-process.md)。

## 2. Compose 拓扑

```
forge-api:3000
forge-worker-llm
forge-worker-tools
forge-console (静态，由 api 托管)
doc-parser:8080
browser:8081
mysql:3306
redis:6379
temporal:7233
temporal-ui:8080
minio:9000/9001
```

开发环境可省略 MinIO（用本地目录适配器），但**测试必须使用 MySQL 8**，不要用 SQLite 替代。

## 3. Kubernetes 部署单元

| 资源 | 副本 | 说明 |
| --- | --- | --- |
| `forge-api` Deployment | 2+ | ClusterIP；`/healthz`、`/readyz`；SSE 关闭代理缓冲 |
| `forge-worker-llm` Deployment | 1–3 | `llm`/`main` 队列；按模型并发扩 |
| `forge-worker-tools` Deployment | 2+ | `http`/`mcp`/`docparse`/`browser`；按资源拆 |
| `forge-migrate` Job | 1 | 发布时运行；备份后执行；不自动重跑 |
| `forge-doc-parser` Deployment | 1+ | Python MCP；CPU/GPU 按需 |
| `forge-browser` Deployment | 1+ | Playwright；严格并发 |
| `forge-console` | — | 构建产物由 API 托管或 Nginx/共享存储 |
| PVC | — | Connector 配置缓存、日志、上传（按需） |
| Secret | — | DB/Redis/S3/主密钥/SSO/Connector/模型密钥 |
| Service | — | ClusterIP；外网只经统一 Nginx |

要求：
- `RollingUpdate`，`maxUnavailable: 0`（数据库迁移兼容前提下）。
- 所有 Pod 非 root、只读根文件系统（除缓存/临时目录）、资源 requests/limits。
- API/Worker 的 `/readyz` 依赖 MySQL/Redis/Temporal；启动时配置校验失败直接退出。
- Worker 使用 Temporal Worker Versioning（P1）或部署时先滚动 API 再 Worker。

## 4. 环境变量

### 4.1 通用

| 变量 | 必填 | 示例/说明 |
| --- | --- | --- |
| `NODE_ENV` | 是 | `production` |
| `FORGE_PUBLIC_URL` | 是 | `https://forge.acme.internal` |
| `PORT` | 否 | 默认 3000 |
| `DATABASE_URL` | 是 | `mysql://forge_app:***@mysql:3306/forge` |
| `REDIS_URL` | 是 | `redis://redis:6379/0` |
| `TEMPORAL_ADDRESS` | 是 | `temporal:7233` |
| `TEMPORAL_NAMESPACE` | 是 | `forge` |
| `S3_ENDPOINT` | 是 | `https://cos.ap-shanghai.myqcloud.com` |
| `S3_REGION` | 是 | `ap-shanghai` |
| `S3_BUCKET` | 是 | `forge-prod` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | 是 | Secret 注入 |
| `FORGE_MASTER_KEY` | 是 | 32 字节 base64；信封加密主密钥；单独托管 |
| `SESSION_SECRET` | 是 | BFF 会话签名 |
| `LOG_LEVEL` | 否 | `info` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 否 | OTel Collector |
| `TOOL_ALLOW_PRIVATE_NETWORK` | 否 | 默认 `false`；仅本地演示 MCP/OpenAPI 时临时开启 |
| `SSRF_ALLOWLIST` | 否 | 目标设计：允许的内网域名/IP；当前 MVP 使用布尔开关 |
| `MCP_ALLOWED_COMMANDS` | 否 | stdio MCP 命令白名单 |
| `DEFAULT_TIMEZONE` | 否 | `Asia/Shanghai` |

### 4.2 SSO / Connector

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SSO_MODE` | 是 | `required`（生产）/`optional`/`disabled` |
| `SSO_TOKEN_VALIDATION_MODE` | 否 | `oidc`（默认）/`agent-principal`/`both`；联调后固定 |
| `SSO_ROLE_MAPPING_REQUIRED` | 否 | 默认 `true`；映射为空拒绝登录 |
| `SSO_ISSUER` | 是 | Keycloak/客户 IdP issuer |
| `SSO_CLIENT_ID` | 是 | OIDC 客户端 |
| `SSO_CLIENT_SECRET` | 是 | Secret 注入 |
| `SSO_AUDIENCE` | 否 | 按 IdP 配置 |
| `SSO_SESSION_TTL_SECONDS` | 否 | 默认取签名配置，最大 86400 |
| `AGENT_CONNECTOR_ENABLED` | 是 | 默认 `false`；首次部署保持关闭 |
| `AGENT_CONNECTOR_INBOUND_ENABLED` | 是 | 默认 `false` |
| `AGENT_CONNECTOR_OUTBOUND_ENABLED` | 是 | 默认 `false` |
| `AGENT_CONNECTOR_LEGACY_FALLBACK_ENABLED` | 是 | 固定 `false`（公司新项目） |
| `AGENT_URL` | 是 | Agent 平台 |
| `AGENT_TOKEN_URL` | 是 | Keycloak Token 端点 |
| `AGENT_CONNECTOR_ENVIRONMENT` | 是 | `test`/`staging`/`prod` |
| `AGENT_CONNECTOR_SYSTEM_ID` | 是 | Agent 管理员下发 |
| `AGENT_CONNECTOR_ID` | 是 | Agent 管理员下发 |
| `AGENT_CONNECTOR_INSTANCE_ID` | 是 | K8s Downward API Pod 名 |
| `AGENT_CONNECTOR_CLIENT_ID` | 是 | 服务身份 |
| `AGENT_CONNECTOR_CLIENT_SECRET` | 是 | Secret 注入 |
| `AGENT_CONNECTOR_CONFIG_KEY_ID` | 是 | 配置验签 Key ID |
| `AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64` | 是 | 配置验签公钥 |
| `AGENT_CONNECTOR_CACHE_PATH` | 是 | `/var/lib/forge/connector/<instanceId>/config.json`；按实例隔离；持久卷或 emptyDir |

> 真实 Secret 只通过 K8s Secret/密钥管理注入；仓库只保留 `.env.example` 与 `secret.yaml.template`。缓存文件权限 `0600`，不得进入镜像/Git。

### 4.3 模型

| 变量 | 说明 |
| --- | --- |
| `FORGE_BOOTSTRAP_ADMIN_EMAIL` | 首次启动应急管理员（部署后禁用/改密） |
| `OPENAI_API_KEY` 等 | 可选；也可在控制台配置 Provider 并存加密凭据 |
| `LLM_HTTP_PROXY` | 内网代理 |
| `LLM_REQUEST_TIMEOUT_MS` | 默认 120000 |

生产推荐在控制台配置 Provider/Model/Route，密钥存凭据库；环境变量仅用于引导/离线。

## 5. 首次部署

1. 准备 MySQL 8（业务库 + Temporal 库）、Redis 7、对象存储、Temporal。
2. 生成主密钥/会话密钥：`openssl rand -base64 32`；存入密钥管理。
3. 配置 `.env`/Secret；SSO/Connector 开关保持 `false`。
4. 执行迁移 Job：`pnpm db:migrate`；再执行权限/角色种子 `pnpm db:seed`。
5. 启动 API → Worker → doc-parser/browser；检查 `/readyz`。
6. 配置 Nginx：`/` 静态控制台，`/admin` `/open` `/integration` `/auth` `/sse` 反代 API；SSE 关闭缓冲。
7. 使用应急管理员登录，配置 SSO；未拿到三方参数时先保持 SSO 不对外开放，用应急管理员完成初始配置，不得用本地账号对普通用户开放。完成 OIDC 登录验收后再启用。
8. 配置模型 Provider（自定义 OpenAI-compatible）。
9. 安装示例能力包，运行第一个 Agent。
10. 按 [sso-and-connector.md](../02-architecture/sso-and-connector.md) 第 8 节完成 Connector 灰度；未批准前保持关闭。

## 6. 升级

1. 备份 MySQL（全量 + binlog 位点）与对象存储关键配置。
2. 检查迁移兼容性；先执行迁移 Job。
3. 滚动 API（新版本兼容旧 schema）；滚动 Worker；更新控制台静态资源。
4. 冒烟：登录、Run、SSE、工具、审批、定时任务、Webhook、权限。
5. 观察 30–60 分钟；异常按发布文档回滚。
6. 数据库迁移只前进；破坏性清理放下一版本。

详见 [release-process.md](release-process.md)。

## 7. 备份与恢复

| 项 | 方案 |
| --- | --- |
| MySQL | 每日全量 + binlog 15 分钟；保留 14 天 |
| 对象存储 | 版本控制/跨区副本；生命周期与 Run 保留一致 |
| Temporal | 独立库随全量备份；恢复后校验 namespace |
| Connector 配置 | 每个实例持久缓存；丢失可重新拉取（需网络与有效身份） |
| 主密钥 | 单独托管；丢失将无法解密凭据 |
| 恢复演练 | 每月一次；RPO ≤ 24h（binlog 可到 15min），RTO ≤ 4h |

恢复顺序：MySQL → 对象存储 → Temporal → API/Worker → 控制台 → 冒烟。禁止直接覆盖生产库；恢复到新库并切换。

## 8. 健康、监控与日志

- `/healthz`：进程存活；不依赖外部。
- `/readyz`：MySQL/Redis/Temporal/对象存储；失败返回 503 与组件名（不泄露地址）。
- `/metrics`：Prometheus；Run、队列、模型、工具、审批、Webhook、DB/Redis。
- Trace：`run`、`model.call`、`tool.call`、`connector.call`、`webhook.deliver`。
- 日志：pino JSON；固定字段；敏感字段脱敏；错误只在边界记录。
- 建议告警:
  - API 5xx > 1% / 5min；`readyz` 失败；
  - Temporal 队列积压 > 阈值；
  - 模型错误/限流突增；
  - 审批等待 > SLA；
  - Webhook 失败率；
  - MySQL 慢查询/连接数/磁盘；
  - Connector 心跳丢失/配置漂移。

## 9. 安全加固

- 全链路 TLS；Nginx HSTS；仅暴露统一入口。
- K8s NetworkPolicy：API 仅访问 MySQL/Redis/Temporal/S3/模型端点；Worker 按需；MCP 服务限制出站。
- 容器非 root、只读根 FS、seccomp/AppArmor；不挂 Docker socket。
- Secret 不落盘、不进日志；Connector 缓存 `0600`。
- DB 账户最小权限；迁移账户仅 Job 使用。
- 管理端 CSRF、CSP、安全 Cookie；开放 API 仅服务端调用。
- 关闭 Pi 内置 bash/文件工具；代码执行只在 P2 沙箱。

## 10. 离线/私有化

- 镜像 `docker save`/`podman save` 打包；镜像仓库/Harbor 离线仓库。
- 依赖与能力包预先下载；禁止运行时访问公网。
- 模型端点使用客户内网 OpenAI-compatible；或离线模型服务。
- OIDC 使用客户 IdP；无 IdP 时部署 Keycloak。
- 许可证/版本信息展示在“关于”；不依赖外部 License 服务（P2 如需另行设计）。

## 11. 容量基线（50 人）

| 组件 | 建议 |
| --- | --- |
| MySQL | 8 vCPU / 16 GB / 200 GB SSD |
| Redis | 2 GB，AOF everysec |
| Temporal | 4 vCPU / 8 GB |
| API | 2 × (2 vCPU / 4 GB) |
| Worker | 2 × (4 vCPU / 8 GB)，按队列拆 |
| 对象存储 | 500 GB 起 |
| 连接池 | API 每实例 20；Worker 每进程 10；MySQL `max_connections` 300 |

## 12. 故障排查

| 现象 | 排查 |
| --- | --- |
| Pod CrashLoop | 配置校验日志、Secret 是否存在、迁移版本是否匹配 |
| ImagePullBackOff | 镜像仓库 凭据/imagePullSecret、镜像 tag/digest |
| `/readyz` 失败 | MySQL/Redis/Temporal/S3 连通性；网络策略 |
| SSO 登录 500 | issuer/callback/secret/时钟偏差；IdP 可达性 |
| 角色映射拒绝 | 映射 code/name、`requireAccessRole`、用户角色 |
| Connector 离线 | Agent URL/Token URL、Client Secret、配置公钥、缓存卷、Instance ID |
| Connector 配置漂移 | 心跳、签名验证、`connector/status`；联系 Agent 管理员 |
| SSE 无输出 | Nginx `proxy_buffering off`、`X-Accel-Buffering: no`、Redis Stream |
| 模型 429 | Provider 并发/RPM/TPM、备用路由、预算 |
| 工具 403/404 | 策略快照、数据范围、Connector grant、Agent 权限 |
| 审批不恢复 | Temporal 信号、审批状态、工作流队列 |
| 定时任务不触发 | Temporal Schedule 状态、服务账号/Agent 是否停用、时区 |
| 数据越权 | 立即禁用相关角色/策略，审计访问，按安全事件处理 |
| 迁移失败 | 停止滚动、回滚应用、检查锁/DDL 兼容；不要直接 downgrade |

## 13. 运维操作边界

- 生产数据库变更只通过发布流程；禁止手工改表/修数据（紧急修复需审批与记录）。
- 禁止手工修改 Connector 配置缓存或替换公钥。
- 禁止关闭验签、CSRF、权限过滤来“临时恢复”。
- 紧急关闭 Connector：将三个开关设 `false` 并滚动重启，记录时间与原因。
- SSO 故障：启用应急管理员；恢复后立即禁用并审计。
- 所有生产操作记录在发布/事故记录中，附镜像 digest、迁移版本与回滚方式。
