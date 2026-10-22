# Forge 统一登录（SSO）与 Agent Connector 接入

版本：1.0　日期：2026-10-21　状态：待评审

> 本文把公司现有「Agent Connector 0.2.0」接入资料与 Forge 架构对齐。**公司所有 Forge 项目必须接入统一登录**；客户私有化部署可替换为客户自有 OIDC，但认证边界与实现要求不变。非 Forge 项目也应复用同一 OIDC/Connector 接入基线，避免各项目各自实现登录与跨系统授权。

## 1. 权威来源与版本

| 项 | 值 |
| --- | --- |
| 接入资料目录 | `<internal-docs>/sso-connector/` |
| 协议版本 | Connector Contract `1.0` |
| Node SDK | `@your-org/agent-connector` 0.2.0，`agent-connector-0.2.0.tgz` |
| Node 制品 SHA256 | `eaf28f8ab99bfbb085a0078777f4ce923ad70e1044a8af7e7d8a82d6cdda20a3`（10,218 bytes） |
| Python SDK | `agent_connector-0.2.0-py3-none-any.whl` |
| Python 制品 SHA256 | `e8791941310c115502ab06b7ecbddf7fb174075aaa64dde71db3ea72fb3824f2`（13,058 bytes） |
| 发布清单 | `release-manifest.json`（gitSha `2ae52ade...`，build 8） |
| SSO IdP | Keycloak，示例 realm `agent-platform`，令牌端点 `https://auth.example.com/realms/agent-platform/protocol/openid-connect/token` |
| Agent 平台 | `https://agent-platform.example.com`（以管理员实际下发为准） |

接入前必须按 `CHECKSUMS.sha256` 或 `release-manifest.json` 校验制品；禁止从公共 npm/PyPI 获取同名包。SDK 使用内部制品：

```json
// package.json
{
  "dependencies": {
    "@your-org/agent-connector": "file:vendor/agent-connector-0.2.0.tgz"
  }
}
```

```txt
# requirements.txt（Python）
./vendor/agent_connector-0.2.0-py3-none-any.whl
```

## 2. 适用范围与强制要求

| 部署类型 | 登录 | 跨系统调用 |
| --- | --- | --- |
| 公司内部 Forge 项目（默认） | **必须**接入 Agent 平台统一 SSO | 默认经 Agent Connector / Gateway |
| 客户私有化，客户有 IdP | 必须接入客户 OIDC；适配层相同 | 可用 Forge OpenAPI 工具直连或客户网关 |
| 客户私有化，无 IdP | 仍需 SSO；由交付方部署 OIDC（Keycloak 等） | 同上 |
| 本地开发 | 可关闭 SSO，但使用独立 dev 配置 | Connector 默认关闭 |

**不可协商**
1. 生产环境不允许仅靠本地账号登录；本地账号只作为 SSO 故障时的应急管理员。
2. 控制台、体验页（P2）以及任何 Forge 派生的管理/业务前端，都使用同一套 SSO，不另建账号体系。
3. 不允许信任调用方自报的 `X-Agent-*`、角色、Scope、用户身份头；必须先验签再注入。
4. 生产、预发布、测试的 Connector 注册身份、Client Secret、Instance ID、配置缓存不得共享。
5. 策略拒绝、硬拒绝、签名失败、环境不匹配必须失败关闭，不允许 legacy fallback 绕过。
6. Client Secret、Token、私钥不得进入代码、Git、镜像层、普通日志、Prompt 或工作流历史。
7. Forge 的 `/admin/v1`、`/open/v1` 不得暴露给 Agent Connector 入站；只开放专用 `/integration/v1`。

## 3. 总体架构

```
浏览器 ──OIDC Authorization Code + PKCE──▶ Agent 平台 IdP (Keycloak)
   │                                              │ id_token / principal
   ▼                                              ▼
Forge Console ──BFF 会话 Cookie──▶ Forge API ──验证/映射──▶ RBAC + 数据权限
                                      ▲
Agent 调度系统 ──签名 Principal──▶ /integration/v1（Connector 入站中间件）
                                      │
Forge 工具 ──AgentConnectorClient.callSystem()──▶ Agent Gateway ──▶ 其他系统
                                      ▲
Forge Connector Runtime ──签名配置/心跳/审计事件──▶ Agent 控制面
```

组件职责：
- **SSO 适配器**：OIDC 登录、会话、JIT 用户、角色映射；支持从 Connector 配置包的 `sso`/`roles` 读取策略。
- **Connector Runtime**：配置加载与验签、Last Known Good、心跳、配置刷新、审计事件上报。
- **入站中间件**：清理身份头、验签 Principal、规范化路径、执行 inbound policy、映射本地用户/服务账号。
- **出站适配器**：把 `callSystem` 封装成 Forge 工具源 `connector`，业务工具不接触目标系统密钥。
- **数据权限**：SSO 角色只映射功能角色；数据范围仍由 Forge 本地策略决定，见 [permissions.md](permissions.md)。

## 4. 统一登录（SSO）

### 4.1 登录流程

Forge 的 BFF（`apps/api`）负责 OIDC，浏览器不接触 Token：

1. `GET /auth/login?returnTo=/agents` → 生成 `state`、`nonce`、PKCE `code_verifier`，写入短期服务端 Cookie/Redis。
2. 302 到 IdP `authorization_endpoint`，参数：
   - `response_type=code`
   - `client_id`（Agent 管理员下发）
   - `redirect_uri=https://{forge-host}/auth/callback`
   - `scope=openid profile email`
   - `state`、`nonce`、`code_challenge`、`code_challenge_method=S256`
3. `/auth/callback`：
   - 校验 `state`、`nonce`、`code_verifier`；
   - 用 `client_secret`（Secret 注入）换 Token；
   - 校验 `id_token` 的签名、`iss`、`aud`、`exp`、`nonce`；
   - 若平台以 Agent Principal 作为 `access_token`，同时按配置包中的 `trust`（issuer/audience/keyId/公钥）验签，并与 `id_token.sub` 对齐；
   - 校验 `environment` 与当前部署一致；
   - JIT 创建/更新用户（`users.idp_issuer`、`idp_subject`），映射角色；
   - 建立 Forge 会话，写入 HttpOnly Cookie（`Secure`、`SameSite=Lax`），CSRF Token 返回给前端。
4. 登录审计：actor、IdP subject、角色、结果、IP、UA；失败不泄露具体原因给浏览器。

> 现状说明：提供的资料包含 SSO 配置契约与 Connector Principal 校验，但未包含完整的 OIDC 授权码接口说明。接入时以 Agent 管理员下发的 issuer/clientId/audience 与联调结果为准。Forge 同时实现「标准 OIDC」与「Agent Principal access_token」两条校验路径，由配置选择，绝不降级为不验签。

### 4.2 会话

- 会话存 Redis（多 API 实例共享），Cookie 只含随机 Session ID。
- TTL 取配置包 `sso.sessionTtlSeconds`（300–86400），默认 8 小时；空闲超时与绝对超时分别可配。
- 刷新：优先 OIDC `refresh_token`；无 refresh token 时在 TTL 内滑动续期，超过绝对 TTL 重新登录。
- 注销：`POST /auth/logout` 删除会话；若 IdP 提供 `end_session_endpoint`，浏览器跳转 RP-initiated logout；本地注销必须成功。
- 多标签页共享会话；权限变更后，服务端每次请求重新计算有效权限（不依赖前端缓存）。
- 应急管理员：独立入口，强密码 + 可选 TOTP；仅 `platform_admin`；登录与操作强制审计；SSO 恢复后提示禁用。

### 4.3 角色映射

配置包中的 `roles.mode`：

| 模式 | 行为 |
| --- | --- |
| `agent_authoritative` | 以 Agent 角色为权威；Forge 只做角色到本地权限集的只读映射 |
| `mapped`（Forge 默认） | 按 `mappings` 把 Agent `code`（可选 `name`）映射为本地角色 |
| `hybrid` | 映射角色 + 本地附加角色；本地不得扩大数据范围 |
| `local_only` | 仅本地角色；仅用于客户自有 IdP/离线场景 |

规则：
- 公司部署默认 `mapped`，`requireAccessRole=true`，`enforceCodeAndName=true`；未匹配到访问角色 → 拒绝登录。
- Connector 模式下以签名配置的 `requireAccessRole` 为准；客户自有 OIDC 模式使用 `SSO_ROLE_MAPPING_REQUIRED`（默认 `true`）。
- 角色映射由 Agent 管理员签名的配置下发；控制台只读展示，变更需走 Agent 管理员。
- **SSO 不决定数据权限**。Agent 角色 → Forge 功能角色；数据范围由 Forge 数据策略单独配置，避免外部系统扩大数据访问。
- 组织归属：优先本地预分配；P1 支持从受信 claim 映射组织。未见明确契约前不按邮箱域名自动推断组织。

### 4.4 受保护路径

- 控制台：除 `/login`、`/auth/*`、静态资源、健康检查外全部要求会话。
- 管理 API：`/admin/v1/**` 要求会话 + CSRF。
- 开放 API：`/open/v1/**` 使用 API Key，不依赖 SSO 会话。
- 集成 API：`/integration/v1/**` 使用 Agent Connector Principal，不使用 Cookie。
- 健康检查：`/healthz` 只返回存活；`/readyz` 检查 MySQL/Redis/Temporal，不泄露内部地址。

## 5. Connector Runtime

### 5.1 环境变量

从资料包 `.env.example` 对齐，密钥只由部署平台 Secret 注入：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AGENT_CONNECTOR_ENABLED` | 是 | 总开关，默认 `false` |
| `AGENT_CONNECTOR_INBOUND_ENABLED` | 是 | 入站开关，默认 `false` |
| `AGENT_CONNECTOR_OUTBOUND_ENABLED` | 是 | 出站开关，默认 `false` |
| `AGENT_CONNECTOR_LEGACY_FALLBACK_ENABLED` | 是 | 迁移期回退，默认 `false`；Forge 新项目禁用 |
| `AGENT_URL` | 是 | Agent 平台地址 |
| `AGENT_TOKEN_URL` | 是 | Keycloak Client Credentials Token 端点 |
| `AGENT_CONNECTOR_ENVIRONMENT` | 是 | `test`/`staging`/`prod` |
| `AGENT_CONNECTOR_SYSTEM_ID` | 是 | Agent 管理员下发 |
| `AGENT_CONNECTOR_ID` | 是 | Agent 管理员下发 |
| `AGENT_CONNECTOR_INSTANCE_ID` | 是 | 每实例唯一；K8s 用 Downward API Pod 名 |
| `AGENT_CONNECTOR_CLIENT_ID` | 是 | 服务身份 |
| `AGENT_CONNECTOR_CLIENT_SECRET` | 是 | Secret 注入，不落库明文 |
| `AGENT_CONNECTOR_CONFIG_KEY_ID` | 是 | 配置验签 Key ID |
| `AGENT_CONNECTOR_CONFIG_PUBLIC_KEY_B64` | 是 | 配置验签公钥（base64） |
| `AGENT_CONNECTOR_CACHE_PATH` | 是 | 持久卷路径，例如 `/var/lib/forge/connector/config.json` |
| `FORGE_PUBLIC_URL` | 是 | 回调与公开地址 |
| `SSO_MODE` | 是 | `required`/`optional`/`disabled`；生产必须 `required` |
| `SSO_TOKEN_VALIDATION_MODE` | 否 | `oidc`（默认）/`agent-principal`/`both`；联调后固定，不保留模糊回退 |
| `SSO_ROLE_MAPPING_REQUIRED` | 否 | 默认 `true`；映射为空拒绝登录 |
| `SSO_ISSUER` / `SSO_CLIENT_ID` / `SSO_CLIENT_SECRET` / `SSO_AUDIENCE` | 是 | OIDC 配置；Connector 模式下 issuer/audience 可来自签名配置，Secret 仍由环境注入 |
| `SSO_SESSION_TTL_SECONDS` | 否 | 默认取配置包，最大 86400 |

### 5.2 生命周期

1. 启动：加载持久缓存（Last Known Good）→ 用固定公钥验签 → 获取/刷新签名配置。
2. 配置成功：发送心跳（instanceId、connectorVersion、protocolVersion、configVersion、status）。
3. 按配置包 `runtime.refreshSeconds`（默认 30s）刷新配置；按 `heartbeatSeconds` 心跳。
4. 刷新失败：按 `failureMode` 处理：
   - `fail_closed`：无有效配置则拒绝入站/出站；
   - `last_known_good`：未超过 `maxStaleSeconds` 的已验签配置可继续使用；
   - `read_only_degraded`：仅 GET/HEAD/OPTIONS 可用。
5. 注册撤销、环境不匹配、签名失败：立即失败关闭，不使用旧凭据恢复访问。
6. 配置版本单调递增；低版本即使签名有效也拒绝。
7. 审计事件批量上报（成功/拒绝/失败），不包含敏感载荷；失败本地有限重试与磁盘缓冲。

### 5.3 多实例与部署

- 每个 API/Worker 实例必须有唯一 `AGENT_CONNECTOR_INSTANCE_ID`；K8s 使用：
  ```yaml
  env:
    - name: AGENT_CONNECTOR_INSTANCE_ID
      valueFrom:
        fieldRef:
          fieldPath: metadata.name
  ```
- 配置缓存必须挂载持久卷（共享存储），仅运行用户可写；权限 `0600`；不得进入镜像或 Git。
- **缓存路径必须按实例隔离**：`/var/lib/forge/connector/<instanceId>/config.json`。多个实例共用一个文件会互相覆盖；固定实例用独立 PVC/subPath，动态 Pod 可用 `emptyDir`（重启后重新拉取）或按 Pod 名的持久子目录。
- 多实例共享 Redis 会话，但不共享 Connector 私钥/实例状态；每个实例独立注册或使用管理员批准的实例命名规则。
- 部署前校验 Pod 能访问 Agent 平台与 IdP；控制器侧能看到在线、配置版本一致、无漂移。

### 5.4 入站（Agent 调 Forge）

只暴露专用集成 API，绝不把 Connector 当反向代理：

```
/integration/v1/agents                  GET   列出对 Agent 开放的 Agent
/integration/v1/runs                    POST  以委派用户/服务身份创建 Run
/integration/v1/runs/{runId}            GET   查询状态
/integration/v1/runs/{runId}/result     GET   获取结果
/integration/v1/runs/{runId}/cancel     POST  取消
```

| 接口 | 请求 | 响应 |
| --- | --- | --- |
| `POST /runs` | `{ "agentKey": "...", "input": { "text": "...", "files": [] }, "metadata": {} }`；身份只取验签 Principal | `202 { "runId": "...", "status": "queued" }` |
| `GET /runs/{id}` | 路径参数 | Run 状态、版本、用量、错误 |
| `GET /runs/{id}/result` | 路径参数 | 终态结果或 409 |
| `POST /runs/{id}/cancel` | 空体/原因 | 当前状态（幂等） |

- 请求体中的 `user`、`roles`、`scopes`、`orgId` 一律忽略/拒绝；主体来自 Principal。
- 只允许调用已发布且对来源系统开放的 Agent；数据范围取 Principal 与本地策略交集。
- 失败返回 `CON-47xx`/`POL-*`；不泄露内部路径或堆栈。

中间件顺序：
1. 丢弃调用方自报的 `X-Agent-*`、`X-User-*`、`X-Role-*` 等身份头。
2. 路径双层解码 + 规范化；拒绝畸形编码、`..`、反斜杠、空字节。
3. 硬拒绝：`/admin/**`、`/open/**`、`/api/credentials/**`、`/api/keys/**`、`/api/secrets/**`、`/api/tokens/**` 及子路径；硬拒绝不能被 grant 覆盖。
4. 验签 Principal：issuer、audience、exp、签名、environment、application/目标系统。
5. 执行签名 inbound policy（peer system、方法、路径、capability、rateLimit、dataScope）。
6. 映射身份：
   - `user` / `delegated_user` → `users`（按 `idp_subject` 或 `enterpriseUserId`）；未知用户默认拒绝，除非策略允许 JIT。
   - `service` → `service_accounts`；服务身份不自动获得 Web 用户权限。
7. 计算 Forge 功能权限 + 数据权限；数据范围取 Principal 签名策略与本地策略的**交集**，不得由外部扩大。
8. 审计：principal、sourceSystemId、grantId、方向、结果、traceId；不记录 Token/完整敏感载荷。

不支持的数据范围（例如非空 `dataScope` 的未知类型）必须拒绝，不能静默忽略。

### 5.5 出站（Forge 调其他系统）

Forge 新增工具源类型 `connector`：

```yaml
key: pm-project
name: PM 项目管理
type: connector
targetSystemId: "<Agent 管理员下发>"
operations:
  - key: first_reach_time
    method: POST
    path: /service-task/phoenixtask/projectOpen/v1/project/website/serviceFirstReachTime
    capability: project.read
    dataScope: project
```

执行路径：
```
ToolExecutor → ConnectorToolSource
  → 本地签名策略预检（grant、方法、路径、capability、rateLimit）
  → AgentConnectorClient.callSystem(targetSystemId, input)
  → Agent Gateway 权威校验 + 审计
  → 目标系统
```

- Forge 不保存目标系统密钥；目标鉴权由 Agent Gateway/目标系统完成。
- 工具定义仍登记输入/输出 Schema、风险级别、审批规则；`high` 风险默认审批。
- 出站关闭时，工具调用直接失败，不允许代码直连回退。
- 直连 OpenAPI 工具仍保留，用于客户私有化无 Agent Gateway 的场景；公司内部项目默认优先 `connector`，需在项目接入表中声明。

## 6. 配置包与信任

签名配置包（`config-bundle.schema.json`）包含：
- `system`：System ID、code、environment、status；
- `trust`：Principal issuer/audience/keyId/公钥；
- `sso`：mode/issuer/clientId/audience/sessionTtl/protectedPaths；
- `roles`：mode/requireAccessRole/enforceCodeAndName/mappings；
- `calls`：inbound/outbound 策略；
- `runtime`：failureMode/refreshSeconds/maxStaleSeconds/auditBatchSize/heartbeatSeconds。

Forge 处理：
- **Connector 模式**：SSO 与角色映射以签名配置为权威；控制台只读展示。Client Secret 不在配置包，仍由 Secret 注入。
- **客户自有 OIDC 模式**：没有 Connector 时，`sso_providers` 保存 issuer/clientId/secret/audience/role mappings；仍使用同一 OIDC 实现与安全校验。
- 配置刷新后，Forge 热更新 SSO 策略与角色映射；已建立会话在下一次请求重新计算权限。
- 配置降级/撤销时，禁止新登录与新集成调用；已有会话按策略失效，不能无限期使用旧配置。

## 7. 安全不变量（必须实现）

1. 配置验签公钥与 Principal 验签公钥分离，私钥只在 Agent。
2. 配置公钥在注册时固定；后续网络响应不能替换信任根。
3. 入站先清除自报身份头，再验签注入。
4. Principal 校验 issuer/audience/expiry/signature/environment 后才建立身份。
5. 路径双层解码并规范化后再做硬拒绝与策略匹配。
6. 硬拒绝前缀不可被管理员 grant 覆盖。
7. 生产/测试/预发布身份与缓存完全隔离。
8. 撤销后配置刷新、入站、出站全部失败关闭。
9. 日志不写 Client Secret、Token、私钥、完整敏感载荷。
10. 拒绝不得走 legacy fallback；`AGENT_CONNECTOR_LEGACY_FALLBACK_ENABLED` 在公司新项目中固定 `false`。
11. Forge 本地授权（功能+数据）与 Agent 授权同时生效，取交集；外部授权不能扩大本地权限。

## 8. 首次接入流程（与资料包对齐）

1. 填写 `THIRD_PARTY_INTAKE_FORM.md`：系统名、英文代码、负责人、技术栈、环境、地址、健康检查、实例规则、入站/出站范围、黑名单、发布与回滚方式。
2. 校验 SDK 制品 SHA256，锁定依赖。
3. 向 Agent 管理员申请：System ID、Connector ID、Client ID/Secret、配置 Key ID/公钥、OIDC issuer/clientId/audience、目标 System ID 与 grant、角色映射。
4. 部署时所有开关 `false`；验证健康检查、原业务、重启、回滚。
5. 配置 Connector（Enrollment 由管理员完成或使用一次性 Token）。
6. 管理员发布最小灰度策略；Forge 开启单实例、最小 grant。
7. 按验收清单联调：登录、会话、角色映射、入站、出站、拒绝、撤销、缓存恢复。
8. 管理员批准后开启生产开关；观察约定周期再全量。

### 8.1 验收清单（Forge 版）

- [ ] SDK 文件名/大小/SHA256 与发布清单一致，依赖锁文件已提交。
- [ ] 生产 SSO 为 `required`，本地账号仅应急。
- [ ] 登录、回调、注销、会话过期、多实例会话正常。
- [ ] `id_token`/Principal 验签通过；伪造、过期、错误 audience/environment 被拒。
- [ ] Agent 角色 code/name 映射正确；无访问角色被拒。
- [ ] 自报身份头被清除；`/admin`、`/open`、凭据路径硬拒绝。
- [ ] 入站 grant、黑名单、方法、限流、dataScope 全部生效。
- [ ] 出站仅走 `callSystem`，无直连回退；未授权目标/方法/路径在本地失败。
- [ ] 配置缓存持久、权限 0600、不进入 Git/镜像；重启可恢复。
- [ ] 心跳在线、配置版本一致、无漂移；撤销后失败关闭。
- [ ] 日志/审计不含 Secret/Token/完整载荷；connector 事件可查。
- [ ] 关闭三个开关后原业务与健康检查正常；回滚演练完成。

## 9. 与 Forge 权限模型的关系

- **功能权限**：SSO 角色 → Forge 角色 → 权限码。外部角色不能直接获得 Forge 管理员权限，必须显式映射。
- **数据权限**：Forge 本地数据策略独立计算；Agent Principal 的 `dataScope` 作为上限之一，与本地策略取交集。
- **服务账号**：定时任务、Agent 入站服务调用使用 `service_accounts`，拥有独立角色与数据范围，不冒用真人身份。
- **API App**：开放平台仍以 API Key 为主体，数据范围默认仅限自己创建的 Run/Thread/File，不能读取其他应用数据。
- 详见 [permissions.md](permissions.md)。

## 10. 第三方参数与实现默认

### 10.1 已决策（不需要等待第三方）

1. **令牌校验**：Forge 同时实现标准 OIDC 与 Agent Principal 两条路径，`SSO_TOKEN_VALIDATION_MODE=oidc|agent-principal|both`，默认 `oidc`；`id_token` 始终按 OIDC 校验，`agent-principal` 额外验签 `access_token` 并校验 `sub` 对齐。联调确认后固定为实际模式，不保留模糊回退。
2. **角色映射**：必须显式配置。映射为空时拒绝登录（`SSO-1201`），由应急管理员先完成初始化；不按角色 code 自动授权。
3. **组织归属**：默认本地分配，不从邮箱域名推断；未分配组织只有 `self` 数据范围。
4. **入站范围**：P0 固定为 `/integration/v1/agents`、`/runs`、`/runs/{id}/result`、`/runs/{id}/cancel`；新增能力必须由 Agent 管理员发布 grant 并更新文档。
5. **出站范围**：未取得目标 System ID 与 grant 时，Connector 工具源保持停用；不直连回退。
6. **多实例**：Instance ID 每实例唯一，缓存路径按实例隔离；动态 Pod 可用 emptyDir，重启后重新拉取配置。
7. **SDK 版本**：固定 0.2.0，按发布清单校验 SHA256；升级需重新验收，不自动跟随。
8. **未提供三方参数时**：Connector 三个开关保持 `false`；SSO 可先用应急管理员完成初始化；开发/测试使用 Mock IdP 与 contract vectors。**不阻塞 P0 代码交付，只影响生产开通。**

### 10.2 部署时由 Agent 管理员提供

| 参数 | 获取方式 | 缺失时 |
| --- | --- | --- |
| Agent URL、Token URL | 非秘密，管理员提供 | Connector 关闭 |
| Environment、System ID、Connector ID | 非秘密，管理员提供 | Connector 关闭 |
| `Instance ID` | 部署规则；K8s 用 Pod 名 | 不启用 Connector |
| Client ID、Client Secret | Client ID 非秘密；Secret 走密钥渠道 | 不启用 Connector |
| 配置 Key ID、配置验签公钥 | 非秘密，可信渠道 | 无法验签，保持关闭 |
| OIDC issuer、clientId、audience | 非秘密，管理员提供 | SSO 仅应急管理员 |
| OIDC Client Secret | 密钥渠道 | 无法完成授权码交换 |
| 回调白名单 | `https://{forge-host}/auth/callback` | 登录失败 |
| Agent 角色 code/name 清单 | 管理员提供 | 映射为空，拒绝 SSO 登录 |
| 入站 grant/黑名单/限流 | 管理员 Portal 配置 | 入站保持关闭 |
| 出站目标 System ID/方法/路径/capability/dataScope | 管理员批准 | 对应工具停用 |

> 测试、预发布、生产分别登记；不得复制其他环境的 ID/Secret/缓存。

### 10.3 发给 Agent 管理员的资料清单（可直接转发）

```text
系统名称：Forge Agent 平台
建议英文代码：forge（以管理员确认为准）
技术栈：Node.js 24 + TypeScript；Agent Connector 0.2.0
部署方式：K8s / Docker Compose
环境：test / staging / prod（分别登记）
访问地址：https://<forge-host>
SSO 回调：https://<forge-host>/auth/callback
健康检查：GET /healthz、GET /readyz
实例模式：固定/自动扩缩容；Instance ID 规则：由部署方填写
入站需求：仅 /integration/v1（创建/查询/取消 Run）
出站需求：通过 callSystem 调用 <目标系统列表>
黑名单：/admin、/open、/api/credentials、/api/keys、/api/secrets、/api/tokens
请提供（非秘密）：Agent URL、Token URL、Environment、System ID、Connector ID、
                    Client ID、配置 Key ID、配置验签公钥、OIDC issuer/clientId/audience、
                    Agent 角色 code/name 清单、入站/出站 grant、目标 System ID
请通过密钥渠道提供：Client Secret、OIDC Client Secret（如需）
```

## 11. 需求映射

| 需求 | 覆盖 |
| --- | --- |
| FR-GV-22 统一 SSO | 第 4 节 |
| FR-GV-23 Agent Connector 接入 | 第 5、6 节 |
| FR-GV-24 SSO 角色映射 | 第 4.3 节 |
| FR-GV-12 应急管理员 | 第 4.2 节 |
| FR-GV-25 Connector 入站隔离 | 第 5.4 节 |
| FR-TL-13 Connector 出站工具 | 第 5.5 节 |
| FR-TL-14 数据范围传递 | 第 5.5、9 节 |
| FR-DLV-07 发布开关与验收 | 第 8 节 + [release-process.md](../06-operations/release-process.md) |
