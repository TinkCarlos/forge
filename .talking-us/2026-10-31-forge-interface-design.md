# Forge 补充接口与交互设计

版本：1.1　日期：2026-10-31　状态：方案级契约草案。与[主方案](2026-10-31-forge-completion-plan.md)、[数据设计](2026-10-31-forge-data-design.md)及既有 API 契约组合使用。

## 1. 接口兼容约定

- 管理端继续使用实际 `/admin/api`，开放端继续 `/open/v1`，Connector 入站继续 `/integration/v1`。不为目录整理破坏现有路径。
- 已存在的 `/providers`、`/models`、`/agents/:id/publish`、`/agents/:id/run` 保留；原目标文档的新增路由落地前明确路径映射，不能悄悄把旧调用改到 `/admin/v1`。
- 认证顺序：认证主体 → 功能权限 → 请求Schema → 资源数据范围 → 领域逻辑。不存在/无数据权限统一404；功能权限不足403。请求解析错误沿用当前Fastify边界，不为调整顺序引入兼容回归。
- 创建/外部副作用请求支持 Idempotency-Key；同键同规范体重放、同键异体409；业务结果记录与幂等完成同事务或由可查询状态恢复。
- 配置编辑使用 If-Match 和 revision，409保留前端草稿并提示刷新比较；不得自动覆盖。新接口缺 If-Match 返回428，旧接口兼容窗口以正式契约公布。
- 新增分页 `{items,nextCursor}`，cursor不透明、绑定筛选/排序；Run按`created_at DESC,id DESC`，默认50、最大200。旧items字段不变；跨页期间新增记录不改变已扫描边界。
- 错误仍为 `{error:{code,message,requestId,details,remedy,retryable}}`；remedy为新增可选兼容字段，敏感信息不进入details。
- 文件Scope暂沿用现有契约的`files:write`读取/上传/删除，Artifact沿用`runs:read`；若拆细files:read应作为独立Scope迁移，不能自动给旧Key扩大授权。

## 2. 对外业务接口补齐映射

现有目标API已经定义的功能优先实现原契约。表中“补”表示新增能力，“扩”表示现有接口增加兼容字段；下列并非已经注册的端点。

| ID | 方法/相对管理路径 | 权限/归属 | 输入、结果与关键语义 |
| --- | --- | --- | --- |
| A01 | 扩 POST `/apps/{id}/keys` | apikey.manage + App可写 | name、expiresAt可空且必须在未来；只返回一次明文Key |
| A02 | 补 POST `/api-keys/{id}/revoke` | apikey.manage + App可写 | 无body；重复成功；认证即时失效，写审计 |
| A03 | 补 POST `/api-keys/{id}/rotate` | 同A02 | overlapSeconds默认0，建议上限86400；返回新Key一次，旧Key到期/撤销时间明确；重放不再次生成密钥，丢失明文按再轮换恢复 |
| A04 | 扩 POST `/agents/{id}/publish` | agent.publish + Agent可写 | versionId、changelog；返回validationErrors；依赖检查失败422且发布指针不变 |
| A05 | 补 POST `/agents/{id}/validate` | agent.manage + Agent可写 | versionId；只读检查返回字段/资源定位诊断，不触发模型、工具或脚本 |
| A06 | 补 POST `/providers/{id}/discover-models` | model.manage + Provider可写 | 返回待导入模型目录；供应商不支持时明确失败，不创建虚假列表 |
| A07 | 补 `/llm/routes` 的CRUD/test、`/llm/usage` | model/usage权限 + 数据范围 | 路由候选/条件、预算、时间/聚合维度；测试进入调试Run，不绕过用量 |
| A08 | 补 PATCH `/tools/{id}`、POST `/tools/{id}/test` | tool.manage + 可写 | 覆盖描述/风险/启停；test(args)→202 runId，副作用按审批执行 |
| A09 | 补 MCP工具配置/test及`/mcp/{id}/references` | mcp.manage/view + 数据范围 | 可配置覆盖与上游发现分存；刷新不覆盖管理员设置 |
| A10 | 扩 GET `/runs`；补 POST `/runs/{id}/retry` | run.view / agent.run + 原Run可读及Agent可运行 | cursor/状态/Agent/App/主体/时间；retry新建Run、返回202，副作用必须确认且继续权限复核 |
| A11 | 补 Thread管理CRUD、消息与文件列表 | 新增thread.view/manage/run权限 + Thread数据范围 | 重命名revision；删除前活动Run需取消并确认，不能删仍写入的workspace |
| A12 | 补 `/apps/{id}/webhooks`、启停/重放 | apikey.manage + App可写 | events、url、secretRef、失败阈值；连续失败停endpoint，重放按eventId去重 |
| A13 | 补 `/org-units`写操作、组/角色/策略/预览 | 已有目标org/role/policy权限 + 可管理范围 | 组织移动不得成环；自提权拒绝；preview只读、解释有效范围 |
| A14 | 补 `/secrets`管理与轮换 | secret.manage + secret作用域 | 明文只允许写入，不提供读取接口；轮换状态可查，引用/禁用保护 |
| A15 | 扩 Schedule版本/并发/历史/告警 | schedule权限 + 服务账号可用 | 固定版本/发布版本，skip/queue/cancel_previous；修改失败保持旧配置 |
| A16 | 补包预检/安装任务/升级/回滚/导出/引用 | package权限 + 作用域 | 预检无执行副作用；提交返回安装任务，查询状态，失败不污染活动版本 |

权限码最终只在core注册表定义，上表新权限属于拟新增，需同步种子、数据策略、菜单和测试。执行入口补齐之前，不用通用admin权限临时绕过。

Key轮换明文不能以原始响应长期保存在普通幂等表：第一次响应后只持久化新Key元数据和操作结果；重复请求返回同一Key id及`secretAvailable:false`。这是显式的秘密一次可见规则，不承诺丢包后可恢复明文。

## 3. 文件、Skill、workspace与执行环境接口

### 3.1 文件与Skill

| ID | 方法/路径 | 认证与输入 | 返回/限制 |
| --- | --- | --- | --- |
| F01 | POST `/admin/api/files`；POST `/open/v1/files` | 管理端file.upload、开放端files:write；multipart文件、可选threadId | 201 fileId/status=ready/checksum；对象上传和元数据完成前不返回ready；大小上限为配置值 |
| F02 | GET `/admin/api/files/{id}`；GET `/open/v1/files/{id}` | file.view或files:write + 行权限 | 元数据与短期downloadUrl/expiresAt；每次重新鉴权，URL不写日志 |
| F03 | DELETE 同F02 | file.delete或files:write + 可写/无引用 | 202删除任务或204已删除；有运行/版本引用409 |
| F04 | GET `/admin/api/artifacts/{id}`；GET `/open/v1/artifacts/{id}` | artifact.view或runs:read + 所属Run/文件权限 | ready才有downloadUrl；archiving/failed返回状态及恢复动作 |
| F05 | POST `/admin/api/skills/{id}/versions/{versionId}/resources` | skill.manage + 草稿版本可写 | 资源文件归入版本清单，校验路径与大小；已发布409 |
| F06 | POST `/admin/api/skills/import`；GET `/admin/api/skills/{id}/export` | skill.manage/view + 作用域 | 导入标准Skill目录包/forgepkg；导出固定版本与资源，不导出凭据 |
| F07 | POST `/admin/api/skills/{id}/validate`；GET对应preview/references | skill.manage/view | 校验/上下文预览/引用，不执行脚本；诊断数组含path/field/code |

Open Run请求扩展`input.files:[{fileId}]`和可选`execution.templateId`，只接受ID，禁止输入storageKey/宿主路径/任意环境变量。未提供执行模板时用Agent发布配置；配置无执行能力则不启动执行器。

### 3.2 管理及会话交互

| ID | 方法/管理路径 | 权限 | 行为 |
| --- | --- | --- | --- |
| S01 | `/execution-templates` GET/POST；`/{id}` GET/PATCH | 新增execution.template.view/manage | 运行环境fingerprint、资源上限、revision；没有网络白名单表单 |
| S02 | GET `/threads/{id}/workspace` | thread.view + workspace数据范围 | 状态、已提交文件版本、用量、最近错误；无管理凭据 |
| S03 | POST `/threads/{id}/workspace/resume` | thread.run + 可写 | 返回202 operationId；恢复运行环境/文件，ready前不得写命令 |
| S04 | POST `/threads/{id}/workspace/suspend` | thread.manage + 可写 | 无活动命令才开始；忙时409，不通过回收按钮隐式取消Run |
| S05 | GET `/threads/{id}/workspace/files` | thread.view + 文件权限 | 仅已提交checkpoint；cursor、相对path；禁止跨目录 |
| S06 | POST `/threads/{id}/workspace/files/import` | thread.manage + 文件可读 | fileId、相对目标path、expectedCheckpointId；运行中先排队，冲突409，不无声覆盖 |
| S07 | GET `/runs/{id}/executions`；GET `/executions/{id}` | run.view + tool_call正文权限 | 状态、exitCode、脱敏输出、日志/产物引用、checkpoint；按数据策略隐藏正文 |

不新增公开的任意shell REST端点。用户从正常Agent Run/调试Run发起执行，复用审批和预算；执行管理接口不把运维shell透给用户。

## 4. 执行器服务内部协议

该协议运行在独立Linux原生执行管理服务，前缀`/internal/v1`；不能注册到对外`/integration/v1`，不能让Connector直接访问。使用服务身份双向认证或等价签名验证，执行票据绑定run/workspace/fence/expiry；工作负载进程看不到管理凭据。

| 方法/路径 | 输入 | 输出与语义 |
| --- | --- | --- |
| PUT `/workspaces/{workspaceId}` | runtimeFingerprint、checkpointRef、fenceToken | 202准备任务；同代同参数幂等，由broker从workspaceId映射工作目录、UID和已登记环境，不接受任意宿主路径 |
| GET `/workspaces/{workspaceId}` | 无 | 状态、generation、当前execution；可证明旧写入者是否停止 |
| POST `/workspaces/{workspaceId}/suspend` | expectedFenceToken | checkpoint确认后回收；失败保留数据，返回可查询操作 |
| PUT `/executions/{executionId}` | 以下ExecRequest | 202执行状态地址；同ID同requestHash重放，同ID异体409 |
| GET `/executions/{executionId}` | 无 | prepared/running/succeeded/failed/cancelled/unknown、exitCode、输出引用、checkpoint |
| POST `/executions/{executionId}/cancel` | reason、fenceToken | 202请求已接受；必须另查状态确认进程树已停止 |
| GET `/executions/{executionId}/events` | afterSequence | 有序、可续传的输出/状态事件；不能代替最终状态查询 |

拟定输入（协议示例，不是可执行命令授权）：

```json
{
  "runId": "<run-ulid>",
  "toolCallId": "<tool-call-ulid>",
  "workspaceId": "<workspace-ulid>",
  "fenceToken": 12,
  "operation": "exec",
  "requestHash": "<sha256>",
  "command": "python scripts/process.py",
  "cwd": "/workspace",
  "timeoutSeconds": 300,
  "runtimeFingerprint": "<runtime-manifest-sha256>"
}
```

- executionId由Forge持久意图生成，第一次网络提交前已入库；requestHash由可信侧按规范化字段计算，服务端复算。
- command交给对应workspace账号的Shell，在systemd服务中执行；不拼接成broker shell。cwd只能为服务端映射的工作目录及其子目录；不接受任意UID、unit属性或宿主目录。
- 不设network字段供每次调用降权/放权；环境网络固定为用户确认的无限制模式。
- 环境变量来自最小运行环境及已授权的业务凭据，不继承API/Worker环境；资源限额取Run快照和平台上限中较严格者，不能由模型请求调大。
- runtimeFingerprint必须与workspace已登记环境兼容；不一致返回EXE-4908，使用兼容profile或显式迁移/新会话导入，不能静默升级解释器/依赖。
- read/write/edit/list等operation使用各自Schema；edit要求expectedFileHash，不匹配409。写文件用临时文件+同目录原子替换；文件操作用workspace账号执行；root broker不跟随用户符号链接，UI导出读取已提交对象。
- 每个非只读操作结束先确认systemd cgroup为空再提交checkpoint，再给Forge最终成功。检查点失败时返回明确“执行已发生、持久化未确认”，进入unknown/恢复流程，不能普通重试原脚本。

### 4.1 拟新增执行错误码

以下为本方案预留，正式注册前需再次查重并写入core注册表；不是当前可用码。

| 代码 | 含义 | HTTP / 重试 |
| --- | --- | --- |
| EXE-4901 | 原生执行服务或所需systemd/配额能力不可用 | 503；创建环境可重试，已提交执行须先查询 |
| EXE-4902 | 工作目录无权限或不存在 | 404；不重试 |
| EXE-4903 | 写入代次/目录版本冲突 | 409；刷新后重新决策 |
| EXE-4904 | 执行超时 | 408；命令已可能执行，不自动重试 |
| EXE-4905 | 资源上限触发 | 422；修正输入/资源配置，不自动重试 |
| EXE-4906 | 执行结果未知 | 409；查状态/对账/人工确认 |
| EXE-4907 | 检查点提交或恢复失败 | 503；仅恢复/上传操作可重试，不重跑已执行命令 |
| EXE-4908 | 不支持的运行环境 | 422；修改配置后发布 |
| EXE-4909 | 同执行ID请求体冲突 | 409；不重试 |

不存在“网络不在白名单”错误；连接拒绝、DNS失败、目标认证失败按实际工具错误返回，不解释为Forge网络权限不足。

## 5. 对外事件与状态

- 保留现有Run终态和`message.completed`等事件语义；新增workspace/execution事件均为能力扩展，老客户端可忽略未知type。
- 新事件：`workspace.provisioning/ready/suspending/suspended/restoring/recovery_required`、`execution.started/output/completed/failed/cancel_requested/cancelled/unknown`、`artifact.ready/failed`。
- 事件最小字段eventId/runId/threadId/sequence/type/createdAt/payload；execution事件带executionId、toolCallId，文件事件带fileId/artifactId。payload不含凭据、内部volume路径或管理票据。
- 输出事件只含有界脱敏片段；原始受限日志下载需要独立权限。日志被截断时返回truncated=true和保留范围，不能拼成看似完整的输出。
- Run保持running且cancel_requested=true直到停止被确认；workspace恢复阻塞单独呈现。副作用未知需要确认时Run使用现有waiting_approval及reason=interrupted，不新增含义模糊的“成功但未知”状态。
- Runtime、Webhook、SSE、Console、SDK共同从contracts生成事件类型，禁止各自维护不兼容枚举。

## 6. 控制台任务流与失败反馈

| 任务 | 入口与动作 | 成功结果 | 失败/重访行为 |
| --- | --- | --- | --- |
| 构建脚本Skill | Skill编辑→资源上传→校验→发布→Agent绑定 | 可见固定版本、资源、运行环境 | 校验定位到文件；保留草稿；发布版本只读 |
| 多轮文件处理 | Agent调试/会话→上传→运行→审批→产物 | 文件和下载来自实际已提交对象 | 空闲回收后显示已休眠，下次自动恢复；不丢会话文件 |
| 查看运行 | 运行中心筛选/分页→详情 | 时间线、用量、命令与文件关联 | SSE断线可续传；无权限隐藏正文；未知结果提供对账/确认入口 |
| 取消执行 | Run详情取消 | 先“正在停止”，确认后“已取消” | 超时仍可查停止进度，不先显示成功 |
| 轮换Key | 应用→密钥→轮换 | 一次展示新Key、旧Key失效时间 | 不以缓存表单重新展示秘密；响应丢失走再次轮换 |
| 并发编辑 | 资源详情保存 | revision递增 | 409保留编辑内容，显示冲突并允许重新加载比较 |
| 运维恢复 | 执行环境→恢复详情 | 检查点/运行环境明确，恢复后可用 | 无法证明旧写入者停止则锁定，不提供“忽略错误继续” |

前端保持现有组件、Token、焦点/键盘/错误反馈方式。资源技术参数仅在管理员配置/运行详情必要位置展示；普通用户看到“工作文件”“执行记录”“产物”，不看到内部挂载路径。

## 7. 交接与契约验证

- A/F/S各接口须补controller/service/repository及contract用例；管理、开放、集成认证不混用。
- 对旧路径/字段跑兼容回归；对新接口跑认证、权限、404、边界、并发、幂等、响应丢失和审计。
- Pi审批恢复、sandbox内部协议、snapshot/credential权限、检查点成功语义必须通过主方案C01–C19后才冻结。
- 此文不是生成OpenAPI成品；完整Schema和所有枚举需要在contracts实现时与原API文档同步。P1/P2专项接口沿用原目标并在对应批次冻结，不能以本表代替尚未完成的专项设计。

### A01–A03 实施落地（2026-10-31）

当前路径、精确状态、幂等与明文丢失恢复语义见[管理接口第18节](../docs/03-api/admin-api.md#18-api-key-生命周期2026-10-31-已实现增量fr-op-02)。轮换上限确定为86400秒，必须携带幂等键；复制旧Key的Scope及有效期，重叠只缩短旧Key寿命。重复响应仅元数据，轮换后的新Key可继续轮换。审计与密钥/幂等记录同事务提交，无Schema变更。

## E1配置条件写入落地（2026-10-31）

现存17个配置写入口已统一强If-Match，旧界面、React界面及维护脚本均已迁移，不保留旧用户无锁兼容入口；新角色code创建除外。状态码428/400/409、输入/权限优先级、成功结果特化及控制台恢复语义见[管理API第20节](../docs/03-api/admin-api.md#20-配置版本与条件修改e12026-10-31)和[生成OpenAPI](../docs/03-api/configuration.openapi.json)。完整契约/SDK仍在后续E1范围。
