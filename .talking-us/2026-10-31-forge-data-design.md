# Forge 补充数据设计

版本：1.1　日期：2026-10-31　状态：设计草案，与[主方案](2026-10-31-forge-completion-plan.md)组合使用。

## 1. 事实源与通用规则

设计启动时结构以 [schema.sql](../packages/store/src/schema.sql) 和迁移 001–008 为仓库基线；E1已落地009与Drizzle Schema，详见[revision设计](2026-10-31-forge-revision-design.md)及[开发进度](2026-10-31-forge-development-progress.md)；本轮未连接业务/生产数据库，不代表部署结构实测。目标已有实体沿用 [mysql-design.md](../docs/04-data/mysql-design.md)，下文只补必要差异，不另造同义表。

- MySQL 8.0.30+，InnoDB；ID 为 ULID `CHAR(26) ascii_bin`，时间为 UTC `DATETIME(3)`，金额为 `DECIMAL(12,6)`。
- 配置类对象有 `revision INT UNSIGNED NOT NULL DEFAULT 1`；运行事件/审计追加写。状态变化由领域状态机控制，不依靠宽松 VARCHAR 自行接受任意值。
- JSON 只保存经过 contracts 校验的结构；需要查询/唯一/授权的键必须独立列。外部正文与二进制保存在受控文件/对象层，不能无限增长地塞入快照或事件。
- 以下表和列均为拟新增/拟扩展。E0 已明确：新表补 Drizzle schema 和迁移 SQL，保留现有 mysql2 Repository，迁移执行器只有一个。

## 2. 复用原目标实体及差异

| 数据域 | 沿用原目标名称 | 本次实施重点与兼容 |
| --- | --- | --- |
| 权限 | roles、permissions、role_permissions、role_bindings、groups、group_members、data_scopes、data_policies、principal_data_grants | 当前 data_policies 的简版结构不能直接当成完整策略表；expand 后迁移。旧 user.role/data_scope 保留兼容读，等价回填且不得扩大权限 |
| 资源版本 | agent_versions、skill_versions、mcp_server_versions、tool_sources、llm_providers/models/routes | Agent/Skill 已有版本不可重写；MCP 使用原目标版本表，其他配置在 Run 快照保存非秘密配置副本及 revision，避免新增一套泛化版本表 |
| 快照 | run_policy_snapshots | 每 Run 唯一；冻结依赖版本、工具 schema/风险、模型配置/价格、权限上限、审批/预算、执行环境profile；secret 只保存引用 |
| 包 | plugin_packages/versions/dependencies/installations/installation_versions/installation_resources | 当前 plugins 记录映射到目标结构，保留 legacy_installation_id；现有安装没有 checksum 的资源标 legacy，不编造校验成功 |
| 凭据 | secrets、secret_versions | 作用域、密文版本、key_version、撤销状态；Provider/Webhook 旧密文字段扩展后回填引用，清除旧字段延后版本执行 |
| 配额/用量 | api_quotas、llm_usage_events | 每个模型步骤唯一结算；预占与释放必须有唯一业务键和到期对账。新增 quota_reservations 属拟扩展，正式设计需包含用户/组织/应用三个归属维度 |
| 开放平台 | api_apps、api_keys、message_channels、message_deliveries/attempts、旧webhook_deliveries | 2026-11-01已确认将Webhook归消息管理，替代尚未实施的webhook_endpoints；详见[Job/消息数据增量](20261101-113405-Forge后台优化与Job消息管理-数据库设计文档.md)，保留旧App/事件/投递兼容。Key生命周期已独立落地 |
| 可靠事件 | outbox_events | 与业务状态同事务；仅保存引用或脱敏摘要，消费至少一次、业务键去重 |
| 文件/产物 | files、artifacts | 补上传状态、归属、对象版本和引用；既有 files.storage_path 不原地改成用户路径 |
| 观测/后续 | notifications、usage_daily、知识库/评测相关原目标表 | 按原阶段落地；不得提前生成无消费者的空表 |

## 3. Run、消息、Skill 的最小扩展

### 3.1 Run 与 Thread

| 对象/字段 | 类型/空值/默认 | 语义与写入者 |
| --- | --- | --- |
| runs.runtime_engine | VARCHAR(24)，非空，兼容默认 mysql-legacy | mysql-legacy/mysql-pi/temporal-pi；创建后不可改变，worker 按引擎领任务 |
| runs.snapshot_quality | VARCHAR(16)，非空，默认 legacy | legacy/frozen；旧 Run 不回填伪历史 |
| runs.retry_of_run_id | CHAR(26)，可空 | 新 Run 重试关系，指向原 Run；取消/失败不覆盖原记录 |
| runs.workspace_id | CHAR(26)，可空 | 需要执行环境时绑定 Thread workspace；普通对话可空 |
| runs.workflow_id | VARCHAR(128)，可空 | Temporal 才有，唯一；不存上下文正文 |
| threads.app_id | CHAR(26)，可空 | API App 创建的 Thread 显式归属，来源核验后回填；无法确定则限制访问并人工核查 |
| threads.active_run_id | CHAR(26)，可空 | 单 Thread 当前写入 Run；以行锁/CAS 取得并在终态释放 |
| threads.next_message_seq | BIGINT UNSIGNED，非空，默认 1 | 新消息在同一事务获取单调 Thread 序号 |
| threads.revision | INT UNSIGNED，非空，默认 1 | 重命名/管理编辑的乐观锁 |
| threads.deleted_at | DATETIME(3)，可空 | 逻辑删除；先拒绝新 Run，再按引用/保留规则回收 |
| messages.thread_seq | BIGINT UNSIGNED，兼容期可空 | 新消息唯一(thread_id,thread_seq)；不覆盖现有 run 内 seq |
| messages.protocol_version | VARCHAR(32)，兼容期可空 | 内部消息编码版本，如 forge-pi-1；旧消息使用 legacy 转换器 |

外键使用 RESTRICT 或明确的异步清理，不级联删除正在运行的数据。新索引：`runs(runtime_engine,status,created_at,id)`、`runs(thread_id,status,created_at,id)`、`messages(thread_id,thread_seq)`、`threads(app_id,created_at,id)`。执行顺序查询和权限查询分别核验 EXPLAIN，未实测前不声称性能达标。

### 3.2 run_policy_snapshots.snapshot_json

结构版本单独保存 schemaVersion；关键区块为：

- agentVersionId；dependencies.skillVersions（id/checksum）、packageVersions、mcpConfigs、toolDefinitions（含 input/output schema、风险、只读/副作用标志）。
- modelRoute（冻结候选顺序、协议/端点/参数/价格/能力），credentialRefs（secretId/作用域，绝无明文）。
- policy（主体/App/组织、允许资源范围、预算、审批规则、权限版本、外部范围上限）。
- execution（templateId、templateRevision、runtimeFingerprint、起始workspace checkpointId、资源限额；网络明确为 unrestricted，无 allowlist）。运行时安装的用户依赖在后续执行/检查点记录，不伪造为Run创建时已存在。

快照为不可变事实；凭据撤销、主体停用等实时状态不回写历史快照，而在每次执行时做额外收紧校验。

### 3.3 Skill 版本

沿用原目标字段 `frontmatter_json/assets_json/checksum`，新增 `runtime_requirements_json`（可空 JSON，声明 Python/Node 及用户级依赖需求）。assets_json 为不可变清单：path、blob/storageKey、size、mimeType、sha256；资源总 checksum 由规范化 manifest 计算。

保存草稿可更新当前草稿资源；发布后内容/清单不可变。导入文件名不能作为宿主路径，拒绝绝对路径、`..`、符号链接/硬链接/设备、压缩炸弹；脚本无需可执行位即可通过解释器执行。现有 Markdown 版本转换不执行任何内容。

## 4. 新执行实体

### 4.1 execution_templates（配置）

用途：管理员维护允许使用的执行环境profile与资源上限；不存脚本网络白名单。初版为平台级资源，只有平台管理权限可写，Agent 引用仍受本地权限规则约束。

| 字段 | 类型/约束 | 含义 |
| --- | --- | --- |
| id / key / name | CHAR(26) PK / VARCHAR(64) UNIQUE / VARCHAR(128)，非空 | 模板身份与名称 |
| runtime_fingerprint | CHAR(64)，非空 | 规范化运行环境清单的SHA256；清单含解释器准确版本/路径、架构、ABI/系统兼容标记 |
| runtime_manifest_json | JSON，非空 | 由受信安装工具登记的运行环境，不接受模型自报 |
| runtime | VARCHAR(24)，非空，固定 linux-systemd | 专用Linux服务器原生执行；不配置容器RuntimeClass |
| resources_json | JSON，非空 | cpu/memory/pids/disk/timeout/output 限额，contracts 校验正数与管理员上限 |
| revision / status | INT UNSIGNED 默认1 / VARCHAR(16) 默认active | 配置编辑锁与 active/disabled |
| created_by / created_at / updated_at | CHAR(26) / DATETIME(3) | 审计关联、UTC |

Run 快照复制 runtime_fingerprint/resources/revision；修改模板不改变旧 Run。存在 workspace 引用的旧fingerprint对应的解释器目录不得被清理。

### 4.2 thread_workspaces（持久文件身份）

| 字段 | 类型/约束 | 含义 |
| --- | --- | --- |
| id / thread_id | CHAR(26) PK / CHAR(26) UNIQUE FK RESTRICT | 一个 Thread 一个工作目录 |
| template_id / template_revision | CHAR(26) / INT UNSIGNED，非空 | 当前运行环境配置来源；变更须显式兼容验证，不自动覆盖 |
| runtime_fingerprint | CHAR(64)，非空 | 恢复需要的运行环境清单hash |
| executor_host_id | VARCHAR(128)，非空 | 首版唯一执行主机注册身份；不自动跨主机迁移 |
| unix_uid / unix_gid | INT UNSIGNED，provisioning期间可空 | 每workspace独立、锁定无登录的Linux账号，不在文件存在期间复用 |
| status | VARCHAR(24)，非空 | provisioning/ready/busy/suspending/suspended/restoring/recovery_required/deleting/deleted |
| fence_token | BIGINT UNSIGNED，非空，默认0 | 取得写入权时递增；签名执行票据中携带 |
| active_run_id | CHAR(26)，可空 | 当前唯一写入 Run；与 threads.active_run_id 一致 |
| current_checkpoint_id | CHAR(26)，可空 | 最后已验证并提交的检查点 |
| backend_ref | VARCHAR(255)，可空，内部敏感元数据 | 管理服务返回的目录/执行单元不透明引用，不向用户返回宿主路径 |
| last_active_at | DATETIME(3)，非空 | 仅无活动操作且超过 idle 阈值才能回收 |
| last_error_code | VARCHAR(16)，可空 | 最近恢复/回收失败；不存原始秘密 |
| created_at / updated_at / deleted_at | DATETIME(3)，deleted_at 可空 | 生命周期 |

唯一约束`(executor_host_id,unix_uid)`与`(executor_host_id,unix_gid)`防止会话意外共享账号；provisioning期间UID/GID可暂空，ready前必须赋值且唯一。索引 `(status,last_active_at,id)` 支持回收扫描，`(active_run_id)` 支持 Run 对账。组织/App/主体权限通过 Thread JOIN，不另存可能漂移的重复 owner 字段。

### 4.3 workspace_checkpoints（不可变文件版本）

| 字段 | 类型/约束 | 含义 |
| --- | --- | --- |
| id / workspace_id / generation | CHAR(26) PK / CHAR(26) FK / BIGINT UNSIGNED | UNIQUE(workspace_id,generation) |
| status | VARCHAR(16)，默认 preparing | preparing/ready/failed；只有 ready 可激活 |
| manifest_key / manifest_sha256 | VARCHAR(1024) / CHAR(64)，preparing时可空 | immutable manifest 最后上传并校验 |
| total_bytes / file_count | BIGINT UNSIGNED / INT UNSIGNED，默认0 | 目录统计，不包括不可恢复的内存/进程 |
| runtime_fingerprint | CHAR(64)，非空 | 与当前文件/依赖布局兼容的运行环境 |
| source_execution_id | CHAR(26)，可空 | 来源命令/文件操作，初始检查点可空 |
| created_at / committed_at | DATETIME(3)，后者可空 | UTC |

manifest 定义相对路径、类型（普通文件/目录/符号链接）、size、checksum、对象 key、权限 mode；符号链接保存 linkTarget，不解引用为目标文件。禁止 device/socket/setuid/硬链接；上传的 Skill/能力包仍拒绝符号链接。检查点前确认该账号无活动cgroup/后台写入者；文件遍历在workspace账号下进行，lstat/readlink不解引用链接。恢复也在对应账号下实施；broker不以root跟随用户链接，导出仅使用已提交清单/对象，拒绝工作目录外路径。该规则需覆盖 Python venv 等常见依赖布局。

提交顺序：预留 generation → 上传文件对象 → 上传 manifest →校验可读 → MySQL 事务 CAS workspace 当前 generation/fence → 标 ready 并激活。旧 generation 保留至不再被 Run/恢复引用。跨对象存储与 MySQL 不声称分布式事务；孤立临时对象由对账任务延迟回收。

### 4.4 code_executions（执行账本）

| 字段 | 类型/约束 | 含义 |
| --- | --- | --- |
| id / run_id / tool_call_id / workspace_id | CHAR(26)，id PK，其他非空 FK RESTRICT | 链接身份和工具治理 |
| attempt | INT UNSIGNED，默认1 | UNIQUE(tool_call_id,attempt)；已确认的重执行产生新 attempt |
| request_hash | CHAR(64)，非空 | 规范化请求 hash，重试必须一致 |
| fence_token | BIGINT UNSIGNED，非空 | 已提交的写入代次 |
| operation | VARCHAR(16)，非空 | exec/read/write/edit/list/stat/import/export |
| input_json | JSON，非空，敏感输入受保护 | 参数/文件引用，不允许接收管理进程环境继承 |
| status | VARCHAR(16)，默认 prepared | prepared/running/succeeded/failed/cancelled/unknown |
| backend_operation_id | VARCHAR(255)，可空 | systemd unit名，由executionId派生 |
| host_boot_id | CHAR(36)，可空 | 执行机本次启动标识，重启后用来区分已消失的进程 |
| exit_code | INT，可空 | 进程退出码；无法证明时空，不伪造0 |
| stdout_file_id / stderr_file_id / checkpoint_id | CHAR(26)，可空 | 完整输出及完成后的已提交目录版本 |
| error_code / truncated | VARCHAR(16)可空 / BOOLEAN默认false | 固定错误语义与日志截断 |
| started_at / completed_at / created_at | DATETIME(3)，前两项可空 | UTC |

索引 `(run_id,created_at,id)`、`(workspace_id,status,id)`、`(status,started_at,id)`。执行服务必须持久接受 executionId 并提供查询；MySQL prepared 不足以证明未执行。返回丢失先查，不自动生成下一 attempt。

## 5. 文件、产物与配额补充

- files 保留既有 owner_type/owner_id，增加 org_unit_id/app_id/thread_id 可空列用于已验证归属及索引；owner 始终权威，新增列必须在同一事务由关联资源派生。
- 拟增加 files.status（uploading/ready/failed/deleting/deleted）、storage_version、deleted_at；现有 storage_path 保留为内部对象 key 兼容字段，不作为可由用户指定的路径。
- artifacts 沿用原目标表，增加 status（archiving/ready/failed/deleting/deleted）、file_id 和来源 execution_id；同一执行产物可重复归档但按 executionId+逻辑路径去重。
- 引用检查覆盖 Skill version、Run 输入、workspace checkpoint、Artifact。初版以明确关系查询判断，不使用无法证明准确的单个可变 ref_count；需要引用计数优化时保留对账修复能力。
- quota_reservations：id、subject_type/id、period_start/end、run_id/step_id、metric、reserved/settled decimal、status、expires_at；唯一(subject_type,subject_id,step_id,metric)。取额度/并发许可与 Run 创建的事务顺序固定，对账不能误释放仍在执行的许可。
- 模型价格与输出 token 上限参与最大调用预占；最终结算记录实际金额。若供应商返回不可预见的超额计费，停止后续调用并告警，不能声称调用后检查能撤销已发生费用。

## 6. 迁移和恢复批次

| 批次 | 操作与回填 | 校验/回退边界 |
| --- | --- | --- |
| D1 基础扩展 | revision、runtime_engine、snapshot_quality、Thread序号/App归属、Key管理；新表先空建 | 旧服务可运行；旧 Run 引擎保持legacy；未知App归属不推断开放 |
| D2 权限/凭据 | 旧角色→等价角色绑定，旧org→org_tree；secret密文带旧key_version导入 | 比较每个测试主体有效授权；有扩大即停止；旧加密密钥保留到重加密验证完成 |
| D3 快照/Skill/文件 | 新Run写冻结快照，新Skill增加资源；旧Markdown按无资源兼容；文件状态回填需验证对象存在 | 不给旧Run补虚构版本；缺对象标待核查，不标ready |
| D4 执行环境 | 创建执行模板、workspace/checkpoint/execution表；默认功能关闭 | 未启用原生执行能力可不创建workspace；关功能不删除已有文件 |
| D5 包/Webhook/模型 | legacy安装映射，单Webhook→endpoint，使用事件与配额落地 | 保留legacy映射；不可把同一个事件同时发到新旧投递器 |
| D6 Temporal | 新Run/新Schedule引擎分派，Outbox；旧Run排空 | 不迁移正在运行的旧Run；回退先停新引擎接单，不能让旧worker解释新协议 |
| D7 Contract清理 | 达到版本窗口后关闭旧写接口、删不再引用的字段/对象 | 单独版本执行，前置引用审计、备份和恢复证据；生产不做down migration |

新增迁移编号实施时从实际 schema_migrations 接续，不硬编码009一定空闲。脚本记录每批主键游标/行数/失败项，事务短小，外部上传/下载在事务外。

历史消息排序不能仅按新的假定重排：保留旧 run 内 seq，按历史 created_at/run关系建立可解释的 thread_seq；若历史并发导致无法重建严格先后，标记 legacy ordering 并保留原消息，不伪造全局顺序保证。

数据保留沿用原数据文档；workspace默认随未删除Thread保留，idle只释放计算；数据盘不因进程回收而卸载。控制台明确区分“回收运行环境”和“删除会话文件”，两者不是同一操作。

## 7. 当前未决与验收

本文件给出数据演进方案；E0/E1 需把字段精度、DDL、索引、回填 SQL 和实际部署元数据差异同步回原 mysql-design 文档。完整权限、包、知识库/评测字段沿用原目标专项，不在此复制。

必测：空库、基线库升级、重复回填、中途故障、旧新版本混跑、权限差异、对象丢失、快照CAS失败、两写入者、备份恢复。所有为待执行；本轮仅做文档引用和覆盖检查。
