# Forge 线上发布流程

版本：1.0　日期：2026-10-21　状态：待评审

> 本文是 Forge 项目的发布执行标准。基础设施与发布方式**以现有线上发布规范为准**；本文只补充 Forge 特有的数据库迁移、SSO/Connector、Temporal Worker、权限种子与验收门槛。后续所有 Forge 版本按本文执行并留档。

## 1. 上游权威文档

| 文档 | 用途 |
| --- | --- |
| `<internal-docs>/release/project-deploy-guide.md` | 区域 A K8s、CI、镜像仓库、共享存储、Nginx、MySQL 的基础设施与流程 |
| `<internal-docs>/release/new-project-deploy-guide.md` | 新项目目录、Dockerfile、K8s、Secret、PVC、Nginx、CI 规范 |
| `<internal-docs>/release/nginx-region-a/` | 统一 Nginx 网关配置与 CI 流水线配置（先 `nginx -t` 校验，再写共享存储，再滚动重启） |
| `<internal-docs>/release/nginx-region-b/`、`nginx-region-c/` | 区域 B 环境对应流程（按项目所在集群选择） |
| `<internal-docs>/sso-connector/` | SSO、Agent Connector 0.2.0 接入与验收 |

**冲突处理**：基础设施（K8s/CI/镜像仓库/共享存储/Nginx/Secret/PVC）以上游文档为准；Forge 应用层的迁移、SSO/Connector、Worker 顺序、权限种子与验收以本文为准。若上游文档更新，本文对应章节必须同步修订。

## 2. 发布原则

1. **可回滚**：每次发布必须记录上一个可用镜像 digest、配置版本与数据库迁移版本；回滚方案在发布前确认。
2. **镜像不可变**：生产只部署带时间戳与 commit 的镜像 tag；记录 digest；禁止 `latest` 直接上线。
3. **迁移先行且可兼容**：数据库迁移先于应用滚动；采用 expand/contract，禁止同一版本删列/改语义。
4. **默认关闭**：首次部署或重大变更时，Connector 的入站、出站开关默认 `false`，验证后再按批准范围开启；SSO 在完成登录/角色映射验收前不对外开放（可用应急管理员完成初始配置）。
5. **无证据不发布**：CI、契约、迁移、SSO/Connector、权限、冒烟与回滚演练全部有记录。
6. **Secret 不入库**：真实 Secret 只存在于 K8s Secret/密钥管理，仓库只保留 `.template`。
7. **单一入口**：所有外网流量经统一 Nginx；后端 Service 使用 ClusterIP。
8. **人工闸门**：生产数据库迁移、Agent grant 开启、SSO 生产启用必须有人工审批与操作记录。

## 3. 环境与部署单元

### 3.1 环境

| 环境 | 用途 | 要求 |
| --- | --- | --- |
| `test` | 集成测试 | 独立数据库、独立 Connector 注册；无则不得用生产凭据替代 |
| `staging` | 预发布/灰度 | 尽量与生产同构；独立 SSO/Connector 身份 |
| `prod` | 生产 | SSO `required`，Connector 按批准范围开启 |

测试、预发布、生产不得共享 Client Secret、Instance ID、配置缓存或数据库。

### 3.2 Forge 部署单元

| 单元 | 形式 | 说明 |
| --- | --- | --- |
| `forge-api` | Deployment | Fastify：管理/开放/集成 API、SSE、BFF、静态控制台 |
| `forge-worker-llm` | Deployment | Temporal `llm`/`main` 队列 |
| `forge-worker-tools` | Deployment | `http`/`mcp`/`docparse`/`browser` 队列，可按资源拆分 |
| `forge-console` | 静态文件 | 由 API 托管或走 Nginx + 共享存储；与 API 同版本 |
| `forge-migrate` | Job | 仅发布时运行；执行 Drizzle 迁移与权限种子 |
| MySQL | 外部 托管 MySQL 或集群内 | 业务库 + Temporal 库（独立 database） |
| Redis | 外部/集群内 | SSE、限流、会话 |
| Temporal | 集群内/托管 | 工作流与 Schedule |
| 对象存储 | COS/S3/MinIO | 文件、包、大结果 |
| `forge-doc-parser` | Deployment | Python MCP 服务 |
| `forge-browser` | Deployment | Playwright MCP 服务 |

首版可合并 API/Worker 为一个镜像的不同进程，但生产建议拆分，按队列隔离资源。所有服务实现：

- `GET /healthz`：存活，不检查依赖；
- `GET /readyz`：检查 MySQL/Redis/Temporal/对象存储；
- `GET /metrics`：Prometheus（内网）。

## 4. 版本与制品

- 镜像 tag：`YYYYMMDDHHmm-<git短SHA8>`，例如 `202610211930-a23d269f`；同时推送 `latest` 仅作便利，生产引用具体 tag + digest。
- 记录：版本号、git SHA、镜像 digest、迁移版本、OpenAPI 版本、SDK 版本（Connector 0.2.0）、文档 commit。
- 镜像仓库 保留策略按上游文档（仓库保留 5 个版本，CI 本地 3 个）；发布记录中保存可回滚的 digest，不依赖 `latest`。
- 能力包/前端静态产物与后端版本对应；控制台构建产物带版本号，页面“关于”可查。

## 5. CI 门禁

发布前流水线必须全部通过：

- [ ] Lint、TypeScript 类型检查、单元测试。
- [ ] 集成测试（Testcontainers MySQL 8 + Redis）；迁移从空库执行成功。
- [ ] 契约测试：管理/开放 API、SSE/Webhook 事件、OpenAPI diff。
- [ ] 构建镜像、扫描高危漏洞与密钥泄漏。
- [ ] 控制台构建与关键 E2E（登录、安装、发布、运行、审批、权限）。
- [ ] SSO 登录/角色映射测试（使用测试 IdP 或 Mock，生产联调单独验收）。
- [ ] 数据权限矩阵测试（跨组织、self、deny、API App）。
- [ ] 文档同步检查：需求、接口、数据、发布说明已更新。

任一失败禁止进入部署阶段；不得用 `--no-verify` 或跳过测试绕过。

## 6. 发布前检查

### 6.1 通用

- [ ] 版本与变更说明已评审；影响范围、风险、回滚责任人明确。
- [ ] 上一个生产镜像 digest 与配置快照已记录。
- [ ] 数据库已备份（全量 + binlog 位点）；恢复演练可用。
- [ ] 迁移 SQL 已评审；只含 expand，不含破坏性变更；已知执行时长。
- [ ] Secret 模板与实际 Secret diff 已确认；没有新增明文密钥进入 Git。
- [ ] Nginx 路由变更已在临时 Pod 通过 `nginx -t`。
- [ ] 告警静默/通知人已确认；发布窗口避开业务高峰。
- [ ] 回滚镜像 tag、配置回滚方式、Connector 开关关闭方式已演练。

### 6.2 Forge 专项

- [ ] 迁移 Job 与 API/Worker 版本兼容；旧版本在新 schema 上可运行。
- [ ] Temporal Worker 版本策略已确认；运行中工作流不被新 Worker 破坏。
- [ ] 能力包 manifest 兼容当前 Forge/Pi 版本；安装/升级/回滚测试通过。
- [ ] 权限码与内置角色种子幂等；数据策略迁移不会意外扩大权限。
- [ ] SSO 回调地址、issuer、clientId、audience 与当前环境一致。
- [ ] Connector System ID、Connector ID、Instance ID、配置 Key/公钥、缓存 PVC 与当前环境一致。
- [ ] 首次部署/重大变更：三个 Connector 开关为 `false`，`legacy fallback=false`。
- [ ] Agent 管理员已批准入站/出站 grant、黑名单、限流与灰度范围。
- [ ] 模型 Provider/Route 已在目标环境测试；密钥已通过 Secret 注入。

## 7. 发布步骤

### 7.1 首次部署

1. **建库与账户**：创建业务库、Temporal 库、应用账户；字符集 `utf8mb4`；记录 schema 版本。
2. **命名空间与拉取凭据**：创建命名空间；复制 镜像仓库 imagePullSecret；确认 K8s 可拉取镜像。
3. **Secret**：按 `secret.yaml.template` 创建真实 Secret（不入库）；包含 DB/Redis/S3、主密钥、SSO Client Secret、Connector 凭据、模型密钥。
4. **PVC**：Connector 配置缓存、日志/上传（如需要）；确认 `Bound`。
5. **迁移 Job**：备份后执行 `forge-migrate`；校验 `schema_version`；种子权限/角色。
6. **部署 API/Worker**：先 API，后 Worker；确认 `readyz`；查看日志无迁移/连接错误。
7. **控制台**：确认静态资源版本与 API 一致；访问 `/login` 走 SSO。
8. **Nginx**：按上游流程新增 server/upstream；`nginx -t` 通过后写入 共享存储 并滚动重启；验证 HTTPS、回调、SSE（关闭代理缓冲）。
9. **SSO 验收**：登录、角色映射、拒绝无角色用户、登出、会话过期；无 IdP 时暂用应急管理员完成初始配置，但不得对外开放。
10. **Connector 关闭状态**：三个开关 `false`；健康检查正常；确认原业务无回归；向 Agent 管理员反馈版本/实例/健康结果。
11. **最小灰度**：管理员发布最小 grant；开启单实例入站/出站；按 SSO 验收清单联调。
12. **正式开启**：管理员批准后开启生产开关；观察约定周期再扩大。

### 7.2 常规版本发布

1. 冻结变更，生成版本与变更说明。
2. 备份数据库与配置；记录 binlog 位点。
3. 执行迁移 Job（如无迁移则跳过并记录），确认应用兼容。
4. 推送镜像并按 `kubectl set image` 滚动 API（`maxUnavailable=0`）。
5. 滚动 Worker；确认 Temporal 队列无异常积压；必要时使用 Worker Versioning。
6. 更新控制台静态资源（API 托管或 共享存储），校验版本。
7. 如涉及 Nginx/SSO/Connector：
   - Nginx 走独立 CI 流水线，先校验后生效；
   - SSO 配置变更先在测试环境验证映射；
   - Connector 配置由 Agent 管理员发布签名配置，Forge 等待心跳/配置版本收敛，不手工改缓存。
8. 冒烟与观察（见第 8 节）。
9. 记录发布结果；失败则按第 9 节回滚。

### 7.3 部署顺序

```
备份 → 迁移 Job → API（兼容新旧 schema） → Worker → 控制台 → Nginx/SSO/Connector
```

- 迁移必须向后兼容：旧 API/Worker 在新 schema 上可运行，便于滚动期间混跑。
- 破坏性清理（删旧列/表）放到下一个版本。
- Temporal 工作流代码变更需兼容历史；必要时使用 Worker Versioning/重放测试。

## 8. 发布后验证

### 8.1 冒烟清单

- [ ] `/healthz`、`/readyz` 200；版本号正确。
- [ ] SSO 登录成功；角色映射正确；无角色用户被拒；登出正常。
- [ ] 控制台总览、Agent 列表、模型页可打开；权限菜单正确。
- [ ] 创建一次测试 Run（非生产敏感数据）；流式事件正常；取消可用。
- [ ] 工具调用（测试目标）与审批流正常；审计有记录。
- [ ] 定时任务可创建/触发一次测试任务；下次运行时间正确。
- [ ] 数据权限：跨组织/self/deny 抽查；API App 只能读自身 Run。
- [ ] Webhook 测试事件签名正确、可重放。
- [ ] Connector：在线、配置版本一致、无漂移；关闭开关后入站/出站确实失败。
- [ ] 日志无密钥/Token 泄漏；错误码可检索。

### 8.2 观察窗口

- 至少 30–60 分钟（重大变更 24 小时）观察：
  - API 5xx、P95 延迟、SSE 断连；
  - Temporal 队列积压、工作流失败、审批等待；
  - 模型限流/错误/成本；
  - MySQL 慢查询、锁等待、连接数；
  - Redis 内存/淘汰；
  - Webhook 成功率；
  - Connector 心跳/配置漂移/拒绝率。
- 异常达到回滚阈值立即执行回滚，不等待观察结束。

## 9. 回滚

### 9.1 回滚顺序

1. **关闭入口**：将 Connector `INBOUND/OUTBOUND/ENABLED` 设为 `false`（或至少关闭受影响方向），必要时在 Nginx 下线路由。
2. **回滚应用**：`kubectl set image` 到上一个已验证 digest，或 `kubectl rollout undo`；确认 `readyz`。
3. **回滚配置**：恢复上一版 ConfigMap/Secret（仅必要项），重启相关 Deployment。
4. **数据库**：迁移 forward-only；优先用兼容代码回滚，不轻易恢复数据库。确需恢复时由负责人批准，按备份 + binlog 恢复到新库并切换，禁止直接覆盖生产库。
5. **Nginx**：恢复上一版 `nginx.conf`，`nginx -t` 后写入 共享存储 并滚动重启。
6. **SSO 故障**：启用应急管理员；恢复 IdP 后立即禁用应急账号并审计。

### 9.2 场景对照

| 场景 | 首选动作 |
| --- | --- |
| 新版本 API 错误率高 | 回滚 API 镜像；保留 Worker 兼容版本 |
| Worker 逻辑错误/队列积压 | 回滚 Worker；必要时暂停对应队列 |
| 迁移导致兼容问题 | 回滚应用到兼容版本；评估向前修复，不直接 downgrade schema |
| SSO 登录失败 | 检查 issuer/callback/secret；临时应急管理员；不要关闭验签 |
| Connector 拒绝/签名失败 | 关闭方向开关；检查配置版本/公钥/环境；联系 Agent 管理员 |
| 权限误放大 | 立即回滚权限策略/角色数据；审计影响范围；通知安全负责人 |
| Nginx 路由错误 | 恢复上一版配置并滚动重启；先 `nginx -t` |
| Webhook 大量失败 | 停用端点；修复后重放；不影响主 Run |

## 10. 热修复

- 走同一 CI 与镜像流程；禁止手工改容器内文件。
- 范围最小化；必须有回滚镜像；发布记录注明“hotfix”与关联事故。
- 修复 P0 故障后可先恢复服务，再补测试与复盘；不得跳过备份与迁移评审。
- 24 小时内输出事故复盘：时间线、影响、根因、处置、改进项与责任人。

## 11. 发布记录模板

```markdown
## Forge Release <version>

- 日期/时间：
- 环境：test / staging / prod
- Git SHA：
- 镜像：<registry>/<image>:<tag>（digest: sha256:...）
- 控制台版本：
- 数据库迁移版本：
- OpenAPI/事件版本：
- Connector SDK：0.2.0（SHA256 校验通过）
- 变更摘要：
- 影响范围：
- 迁移：有/无；耗时；备份位点
- Secret/Config 变更：
- SSO/Connector 开关状态：启用前 false → 灰度 → 全量
- 权限/数据策略变更：
- 测试证据：CI 链接、契约报告、E2E、SSO 验收、权限矩阵
- 冒烟结果：
- 观察窗口与指标：
- 回滚镜像/配置/责任人：
- 审批人：
- 备注：
```

## 12. SSO/Connector 发布专项

- 每个环境独立注册；不得复制其他环境 System ID/Connector ID/Instance ID/Secret。
- 首次部署与 SDK 升级必须保持开关关闭，先验证原业务、健康检查与回滚。
- Connector 配置由 Agent 管理员签名下发；Forge 只消费，不手工编辑缓存。
- 开启前确认：配置版本一致、无漂移、心跳健康、最小 grant、黑名单、限流、回滚开关方式。
- 生产 SSO 必须 `required`；本地应急管理员仅故障时使用，恢复后禁用并审计。
- **代码验收与生产开通分离**：P0 代码/测试阶段可用 Mock IdP + contract vectors；生产上线前必须拿到 Agent 管理员参数并完成真实登录、角色映射、入站/出站与拒绝用例。未完成不得开放生产登录/入站/出站。
- 验收按 [sso-and-connector.md](../02-architecture/sso-and-connector.md) 第 8.1 节与原始 `ACCEPTANCE_CHECKLIST.md` 执行。

## 13. 权限/数据策略发布专项

- 权限码种子幂等；新增权限码必须同时更新代码、种子、文档与测试。
- 数据策略迁移先 dry-run，输出影响用户/资源数量；禁止默认放宽到 `all`。
- 发布后抽查：跨组织、self、deny、API App、服务账号/定时任务。
- 权限误放大按安全事件处理：立即回滚策略、审计访问、通知负责人。

## 14. 与上游文档的对应关系

| Forge 发布环节 | 上游参考 |
| --- | --- |
| 镜像构建/推送/滚动更新 | `new-project-deploy-guide.md` 第 3、8 节 |
| K8s Deployment/Service/健康检查/资源限制 | 同上第 4 节 |
| Secret 与 PVC/共享存储 | 同上第 5、6 节 |
| Nginx 路由与发布 | 同上第 7 节；`nginx-region-a/CI 流水线配置` |
| 首次部署步骤 | 同上第 9 节；`project-deploy-guide.md` 第六节 |
| 日常运维/回滚/排障 | 同上第 10、11 节 |
| SSO/Connector 接入与验收 | `sso-connector/` |

> 本文不是基础设施的替代文档。执行人必须同时打开对应上游文档；若上游流程变化，以最新上游为准并更新本文。
