# Forge 部署与运维

版本：1.2　日期：2026-10-25　状态：待评审

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
| `forge-api` Deployment | 1+（见 §14） | ClusterIP；`/healthz`、`/readyz`；SSE 关闭代理缓冲。会话和 OIDC 登录状态存在 MySQL（`auth_sessions`、`auth_oidc_states`，迁移 007），可以跑多个副本。RPM 计数仍在各进程内存里、按进程分别计数，实际每分钟上限 = 配置值 × 副本数。每个副本自带一个 20 连接的池（§11） |
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
| `NODE_ENV` | 是 | 生产写 `production`。**本地开发必须显式写 `NODE_ENV=development`**（跑测试为 `test`）：只有这两个值才允许使用内置开发密钥（启动时打 warn）、非 secure 的会话 cookie、`SSO_MODE` 不为 `required`、`scripts/reset.ts`；未设置或其他任何值一律按生产处理，缺 `FORGE_MASTER_KEY` / `SESSION_SECRET` / `API_KEY_PEPPER` 直接拒绝启动（rc=1，报错只列变量名） |
| `FORGE_PUBLIC_URL` | 是 | `https://forge.acme.internal` |
| `PORT` | 否 | 默认 3000；必须是 1–65535 的整数，否则拒绝启动 |
| `HOST` | 否 | 监听地址，默认 `0.0.0.0`（所有网卡）。只接受 IPv4/IPv6 地址或主机名，不能带协议、端口或空格。单机部署且前面有本机 Nginx 时建议显式写 `127.0.0.1`；K8s 内保持默认，由 Service/NetworkPolicy 控制暴露面 |
| `DATABASE_URL` | 是 | `mysql://forge_app:***@mysql:3306/forge`。所有环境都必须显式设置，代码里没有默认值；缺失时启动失败（rc=1，报错只写变量名，不打印连接串）。`pnpm smoke:isolated` 同样要求显式设置，且只会写以 `_test` 结尾的库 |
| `REDIS_URL` | 是 | `redis://redis:6379/0` |
| `TEMPORAL_ADDRESS` | 是 | `temporal:7233` |
| `TEMPORAL_NAMESPACE` | 是 | `forge` |
| `S3_ENDPOINT` | 是 | `https://cos.ap-shanghai.myqcloud.com` |
| `S3_REGION` | 是 | `ap-shanghai` |
| `S3_BUCKET` | 是 | `forge-prod` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | 是 | Secret 注入 |
| `FORGE_MASTER_KEY` | 是 | base64 解码后必须正好 32 字节（`openssl rand -base64 32`），否则拒绝启动；信封加密主密钥，单独托管。**更换主密钥会导致库里已有密文（Provider 凭据等）无法解密**，没有重新加密流程前不要轮换 |
| `API_KEY_PEPPER` | 是 | API Key 哈希用的 pepper。非 development/test 环境下去掉首尾空白后至少 32 个字符，否则拒绝启动；更换后已有 API Key 全部失效 |
| `SESSION_TTL_SECONDS` | 否 | 会话有效期（秒），300–86400 的整数，默认 28800（8 小时）；超出范围拒绝启动 |
| `FORGE_ADMIN_EMAIL` / `FORGE_ADMIN_PASSWORD` / `FORGE_ADMIN_NAME` | 是（密码） | 应急管理员，`pnpm db:seed` 时写入，**必须在 migrate/seed 之前设好**。密码没有默认值；非 development/test 环境下使用 `.env.example` 里的示例密码会拒绝启动 |
| `SESSION_SECRET` | 是 | BFF 会话签名。非 development/test 环境下去掉首尾空白后至少 32 个字符，否则拒绝启动。只含空白（空格、制表符、换行）的密钥一律视为未设置（P3-18）：`FORGE_MASTER_KEY` / `SESSION_SECRET` / `API_KEY_PEPPER` 在 development/test 下改用内置开发密钥并打 warn（列出变量名），其他环境按上面的规则拒绝启动；`FORGE_ADMIN_PASSWORD` 没有默认值，只含空白时任何环境都拒绝启动并写出变量名；`OIDC_CLIENT_SECRET`、`AGENT_CONNECTOR_CLIENT_SECRET` 只含空白时按未配置处理 |
| `LOG_LEVEL` | 否 | `info` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 否 | OTel Collector |
| `OUTBOUND_ALLOWLIST` | 否 | 出站请求白名单，逗号分隔的 `host:port`（IPv6 写 `[addr]:port`），默认空。列出的目标跳过内网/回环/元数据地址检查（协议仍只允许 http/https）。每项必须是精确的 `host:port`（不支持通配符、CIDR、只写 host；无效项会让进程启动失败）。生产只放行确实需要的内网服务，例如内网模型网关 `llm.acme.internal:443`；**私有部署的 OIDC IdP 也必须列入，否则 SSO 无法登录**。被拦截的请求在服务端日志里记 `outbound.blocked`（host、解析出的 IP、reason）。本地开发连 mock（`pnpm mock:services`）需要 `OUTBOUND_ALLOWLIST=127.0.0.1:8090`；`pnpm smoke:isolated` 会给它启动的 API 自动带上这一项（除非已显式设置）。详见 admin-api.md §2.1 |
| `TOOL_ALLOW_PRIVATE_NETWORK` | 否 | 已废弃：不再绕过出站校验，请改用 `OUTBOUND_ALLOWLIST` |
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
4. 设好应急管理员变量（`FORGE_ADMIN_EMAIL` / `FORGE_ADMIN_PASSWORD` / `FORGE_ADMIN_NAME`）后再执行迁移和种子：`pnpm db:migrate`，再 `pnpm db:seed`。迁移按顺序执行到 `006_audit_org_unit`（审计表补组织单元列），已执行过的会跳过。库名不以 `_test` / `_ux` 结尾时必须带 `--confirm-db=<库名>`，例如 `pnpm db:migrate --confirm-db=forge`。
4a. 构建新控制台：`pnpm build:console`（产物在 `apps/console/dist`，由 API 在 `/next/` 下托管；没构建时 `/next/` 返回 503）。构建脚本固定 `NODE_ENV=production`，不要在构建时注入 `NODE_ENV=development`。
4b. 首次上线前先轮换所有沿用过示例值或曾经在别处出现过的密码和密钥（K-25），再对外开放。
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

### 6.1 1.1 版升级须知（破坏性变更）

以下变更都是安全或输入校验修复，调用方需要按新行为调整。错误码 CFG-8501 表示请求参数不合法，响应里的 `details.field` 指出是哪个字段。

1. **事件流不再下发 `message.delta`**：管理端 Run 事件流和 `/open` 的 Run 事件流，实时和回放都只发打码后的 `message.completed` 和 `run.*` 事件。Worker 不再把 delta 落库；库里已有的 delta 行读取时过滤掉，不回填、不删除。客户端请以 `message.completed` 的全文为准。
2. **管理端 API 不接受未声明的字段**：请求体里出现 schema 没声明的字段返回 400。`/open` 和 `/integration` 不受这条影响。
3. **建用户、改用户不再接受 `orgUnitId`**：传了返回 400 CFG-8501（以前建用户时会被忽略）。
4. **multipart 请求**：管理端写接口（含 PATCH）和 `/auth` 写路由收到 multipart 返回 415，在 CSRF 和鉴权之前拒绝，Content-Type 大小写不影响判断；`/open` 和 `/integration` 收到 multipart 一律返回 400，不建 Run。
5. **JSON 字段校验**：`spec`、`headers`、`input`、`manifest`、`resources`、`capabilities` 是非法 JSON 或形状不对时返回 400 CFG-8501。`input` 必须是对象：传数组、或 JSON 文本解析出字符串、数字时返回 400（以前会被悄悄换成默认值）。读库时遇到形状不对的旧数据按 `{}`（`capabilities` 按 `[]`）处理，warn 里只记表名、列名和 id。
6. **`text` 与 `input` 同时传**：`text` 去掉首尾空白后非空、同时 `input` 是不带 `text` 键的对象时返回 400，不再存成 `[object Object]`。`text` 为空串或只有空白时按没传处理，这时只带 `input` 对象是合法请求。`text: null` 按没传处理只适用于 `/open` 和 `/integration`，管理端试运行传 `text: null` 仍返回 400。
7. **`/open` 和 `/integration` 拒绝空输入**：`text` 和 `input` 都为空时返回 400 CFG-8501，不建 Run、不写审计（以前返回 202 并建出空 Run）。`text` 为空指没传、`null`、空串或只有空白；`input` 为空指没传、`null`、`{}`，或者只有一个 `text` 键且该值按 `text` 的规则为空。管理端试运行和定时任务不受这条影响。
8. **manifest 非法的插件不加载**：它的 MCP 不进工具列表、技能不进系统提示，Provider 调用报 MDL-3001；它带的 Agent 发起 Run 时返回 409 CFG-8503，定时触发只跳过这一次并记下 `last_error_code`，任务不禁用。manifest 修好后自动恢复，其他插件不受影响。

其他行为变化（不破坏兼容）：重装插件沿用原记录的 `pkg_` id；user、tool、assistant 三种消息和 webhook 负载在落库、下发和读取时都经过同一个掩码函数，单独出现的 `sk-` 密钥也会打码。

### 6.2 1.2 版升级须知（破坏性变更）

从 1.1 升级到 1.2 时看这一节；还停在 1.1 之前的部署，先按 6.1 处理，再看这一节。错误码和 `details.field` 的含义同 6.1。

发布时注意（不是接口变化）：会话存在 API 进程内存里，升级过程中重启 API 会让所有人重新登录；停机超过大约 9 秒，控制台里打开着的 Run 弹窗不会再自动重连，需要手动点刷新。详见 §14。

9. **API Key 的有效 Scope 改为与应用当前 Scope 取交集**：以前 Key 创建时复制一份应用的 `scopes`，之后应用再收窄对旧 Key 不生效。现在每次请求的有效 Scope = Key 的 `scopes` ∩ 应用当前的 `scopes`。对升级前已经收窄过 Scope 的应用，旧 Key 会立即失去被收窄掉的 Scope，相应接口返回 `403 POL-2001`；如果仍需要，请先把应用的 Scope 加回去。应用放宽 Scope 不会让旧 Key 变宽，要用新增的 Scope 请新建 Key。不改库里的数据，不需要迁移。
10. **应用的 `scopes` 不能含 `*`**：建应用、改应用时 `scopes` 里任何一项含 `*`（如 `*`、`runs:*`）返回 400 CFG-8501，`details.field` 为 `scopes.{序号}`（以前会保存成功，但 `*` 从来不是通配符，存了等于没开任何 Scope）。库里已存的 `*`（含 `runs:*` 这类）不迁移、不改，照旧不放行任何接口；但这些应用下次保存时，只要请求里带了 `scopes`（包括把原来的整组原样提交），就会返回 400 CFG-8501。处理办法：按 `details.field`（形如 `scopes.2`，序号从 0 开始）删掉对应那一项，改成逐条列出需要的 Scope 后再保存。不带 `scopes` 的部分更新（PATCH）不受影响。

其他行为变化（不破坏兼容）：

- **`/open` 幂等先于每日配额**：`/open` 建 Run 和同步调用（invoke）带已用过的 `Idempotency-Key` 重放时，即使当天配额已用完也返回第一次的响应（同一个 `runId`，响应头 `Idempotency-Replayed: true`），不再返回 429，也不建新 Run。新的 Key 或不带 Key 的请求在配额用完时仍返回 429 OPN-4501。每分钟请求速率（RPM）的检查顺序不变，重放仍计入 RPM，超限照样 429 OPN-4502。
- **所有 429 带 `Retry-After`（整数秒）**：RPM 超限（OPN-4502）为当前一分钟固定窗口剩余的秒数，至少 1；每日配额用完（OPN-4501）为数据库会话时区下距次日 00:00 的秒数（与配额计数同一口径），限制在 1–86400，数据库取不到时保守返回 3600。

其他变化（不影响部署和调用方）：测试框架升级到 vitest 4，不再依赖 tinypool；只影响开发和 CI，运行时依赖不变。

### 6.3 第三次推送之后的版本升级须知（会话存储）

这一版把会话和 OIDC 登录状态从 API 进程内存搬到 MySQL，`forge-api` 可以跑多个副本（§3）。

发布前：

- **先备份，再等确认**：迁移 007 在任何真实库（预发、生产）执行前，先按 §6 第 1 步做一次全量备份，并等 Cursor Jackson 确认后再执行。
- **迁移 007 不破坏数据，可以重复执行**：只新增 `auth_sessions` 和 `auth_oidc_states` 两张表（`CREATE TABLE IF NOT EXISTS`），不改、不删已有表和数据。重复执行只输出 `Migration 007_auth_sessions already applied`。

发布后的变化：

1. **所有人需要重新登录一次**：旧版本放在进程内存里的会话不迁移，切换后表是空的。之后 API 重启或滚动升级不再让用户掉线。
2. **停用用户立即退出**：管理端把用户状态改成停用时，同一个事务里删除该用户的全部会话，所有副本上立即返回 401（以前要等这个用户的下一个请求才失效）。停用部门的行为不变：该部门用户的下一个请求返回 401。
3. **会话按绝对时间过期**：从登录起算 `SESSION_TTL_SECONDS`（默认 8 小时，范围 300–86400，不变），中途访问不会续期。库里只存 token 和 OIDC state 的 SHA-256，不存明文；不记录 IP 和 UA，也不限制每个用户的会话数。
4. **过期清理**：Worker 每 10 分钟删除一次过期的会话和 OIDC 登录状态，每批 1000 行，用 `GET_LOCK('forge:auth-gc', 0)` 保证同一时刻只有一个 Worker 在删。清理没跑也不影响正确性：所有查询都带 `expires_at` 条件，过期的行一律不认。
5. **数据库负载**：每个带会话的请求多一次 `auth_sessions` 主键查询；`last_seen_at` 最多每 5 分钟写一次。连接池上限仍是每进程 20（§11），并发高于 20 时排队。数据库不可用时，带会话的请求返回 503 SYS-9003，不会当成未登录。

回滚：

- **只回滚代码，不删表**。两张表留着闲置，不需要任何删表或改 `schema_migrations` 的步骤。回滚后会话回到进程内存，所有人再重新登录一次。
- 回滚之后再次升级时，先清空两张表（语句见 §7），再启动新版本的 API，避免回滚期间留下的旧会话行重新生效。迁移 007 已经记录过，不会重复建表。

## 7. 备份与恢复

| 项 | 方案 |
| --- | --- |
| MySQL | 每日全量 + binlog 15 分钟；保留 14 天 |
| 对象存储 | 版本控制/跨区副本；生命周期与 Run 保留一致 |
| Temporal | 独立库随全量备份；恢复后校验 namespace |
| Connector 配置 | 每个实例持久缓存；丢失可重新拉取（需网络与有效身份） |
| 主密钥 | 单独托管；丢失将无法解密凭据 |
| 恢复演练 | 每月一次；RPO ≤ 24h（binlog 可到 15min），RTO ≤ 4h |

恢复顺序：MySQL → 清空会话表 → 对象存储 → Temporal → API/Worker → 控制台 → 冒烟。禁止直接覆盖生产库；恢复到新库并切换。

全量备份的流程不变（`auth_sessions`、`auth_oidc_states` 照常包含在全量备份里，不单独处理）。但 **MySQL 从备份恢复后，启动 API 和 Worker 之前，必须先在恢复出的库上清空这两张表**：

```sql
DELETE FROM auth_sessions;
DELETE FROM auth_oidc_states;
```

不清空的话，旧备份里还没过期的会话会重新生效：包括备份之后才登出的会话，以及备份之后才被停用的用户的会话（恢复出的库里这个用户还是启用状态）。清空后所有人需要重新登录一次。

## 8. 健康、监控与日志

- `/healthz`：进程存活；不依赖外部。
- `/readyz`：MySQL/Redis/Temporal/对象存储；失败返回 503 与组件名（不泄露地址）。
- `/metrics`：Prometheus；Run、队列、模型、工具、审批、Webhook、DB/Redis。
- Trace：`run`、`model.call`、`tool.call`、`connector.call`、`webhook.deliver`。
- 日志：pino JSON；固定字段；错误只在边界记录。请求日志的 `req.url` 记录路径和 query，其中键名为 `token`、`access_token`、`refresh_token`、`id_token`、`api_key`、`apikey`、`key`、`secret`、`client_secret`、`password`、`code`、`state` 的值（键名不区分大小写，按百分号解码后匹配，重复键全部处理）替换为 `[REDACTED]`；fragment 不记录，超过 2048 字符截断。未匹配路由的 404 日志和响应里的 URL 也按同样规则处理。请求头、请求体和其他 query 键不在这条规则内，不得在日志里输出凭据。
- 日志里可能含有业务内容和未被规则覆盖的敏感信息。落盘时日志文件权限设为 `0600`、目录 `0700`，只给运维账号读；按天轮转（logrotate 或采集端），本地保留不超过 14 天，长期留存只放在有访问控制的日志平台。不要把日志文件提交到仓库或贴进工单。
- 缓存头：新控制台 `/next/assets/*`（文件名带内容哈希）返回 `max-age=365d, immutable`；`/next/` 入口和 SPA 回退的 `index.html` 返回 `no-cache`，发布后立即生效。Nginx 不要覆盖这两类缓存头，也不要缓存 API 和事件流响应（事件流本身返回 `Cache-Control: no-cache, no-transform`）。
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
- CSP 例外：只有旧版控制台 `/` 和 `/index.html` 允许属性级内联（`script-src-attr` / `style-src-attr 'unsafe-inline'`），`script-src` 仍是 `'self'`。这是架构书面批准的临时例外（S-10，见 permissions.md 4.5），`/next/`、API 和静态资源不放宽；旧版控制台下线后移除。Nginx 不要再叠加或改写 CSP 头。
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
| 连接池 | API、Worker 每个进程一个池，上限 20（`packages/store/src/db.ts`：`connectionLimit: 20`、`waitForConnections: true`、`queueLimit: 0`，代码写死，没有环境变量可调）。超过 20 的并发查询在进程内排队，不会多开连接。总连接数上限约为 20 ×（API 副本数 + Worker 进程数），再加迁移 Job；MySQL `max_connections` 300 |

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

## 14. 已知风险

- **RPM 计数存在 API 进程内存里**（`apps/api/src/routes/open.ts:34` 的 `rateBuckets`）：每个副本各自计数，`forge-api` 跑多个副本时，实际每分钟上限 = 配置值 × 副本数；API 重启后计数清零。需要精确限流时，在统一 Nginx 上另做限流。
- **API 重启时的 SSE**：会话已经存在 MySQL，重启不再让用户重新登录；但控制台 SSE 断线后只自动重连 3 次，大约能撑 9 秒，单个副本停机超过这个时间，打开着的 Run 弹窗要手动点刷新。滚动升级（`maxUnavailable: 0`、多副本）可以避免。
- **测试依赖的已知漏洞（1.2 已解决）**：1.1 用的 vitest 3 依赖链上有 tinypool（GHSA-5gmw-xhrv-c9v3、GHSA-85c8-ppgw-ccpr）和 vitest / @vitest/mocker（GHSA-82fw-gwwq-j7x9、GHSA-qxg6-89mg-rqv8）的漏洞，都是 devDependencies，不进生产运行时。1.2 升级到 vitest 4.1.12 后不再依赖 tinypool，`pnpm audit --dev` 没有已知漏洞。还停在 1.1 的环境不要对不可信分支直接跑测试。
