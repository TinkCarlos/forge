# Forge 功能权限与数据权限设计

版本：1.0　日期：2026-10-21　状态：待评审

> 功能权限回答「能不能用这个功能」，数据权限回答「在这个功能里能看/改哪些数据」。两者同时生效，取交集；任何一方拒绝即拒绝。

## 1. 目标

1. 功能权限可配置：菜单、操作、API 都由权限码控制，角色权限矩阵可在控制台维护。
2. 数据权限可配置：按组织、本人、自定义组织、应用、服务账号等范围控制到行级；P1 支持字段脱敏与单条资源共享。
3. 统一入口：SSO 角色映射为 Forge 角色；Forge 本地数据策略独立计算，外部身份不能扩大本地数据范围。
4. 默认拒绝：没有明确授权即不可见；越权返回 404/403 且不泄露资源存在性。
5. 可验证：所有列表、详情、导出、文件下载、SSE、知识库检索都经过同一 `AccessContext`。
6. 可审计：权限变更、授权预览、敏感数据访问可追溯。

## 2. 主体与角色

| 主体 | 说明 | 权限来源 |
| --- | --- | --- |
| `user` | 控制台用户；SSO 登录或应急管理员 | 角色绑定（全局/组织）+ 数据策略 |
| `service_account` | 定时任务、Agent 入站服务调用等机器身份 | 角色绑定 + 数据策略 |
| `api_app` | 开放平台调用方 | API Key Scope + 应用数据范围（默认仅自身数据） |
| `group` | 用户组，可作为角色绑定主体 | 继承给成员 |
| `role` | 权限集合 | 功能权限 + 数据策略 |

角色分为内置与自定义：
- 内置：`platform_admin`、`org_admin`、`builder`、`operator`、`auditor`、`user`。内置角色可改权限（`platform_admin` 除外）但不可删除。
- 自定义：管理员创建，绑定到全局/组织/用户/组。
- SSO 角色只映射到 Forge 角色，不直接映射权限码；映射关系见 [sso-and-connector.md](sso-and-connector.md)。

## 3. 功能权限

### 3.1 权限目录

权限码格式：`{domain}.{action}`，集中定义在 `packages/core/src/auth/permissions.ts`，数据库 `permissions` 表只存元数据，代码与种子保持一致。

| 域 | 权限码（节选） | 类型 |
| --- | --- | --- |
| Agent | `agent.view`、`agent.manage`、`agent.publish`、`agent.run` | action |
| 能力包 | `package.view`、`plugin.install`、`plugin.uninstall` | action |
| Skill | `skill.view`、`skill.manage` | action |
| MCP | `mcp.view`、`mcp.manage` | action |
| 工具 | `tool.view`、`tool.manage` | action |
| 模型 | `model.view`、`model.manage`、`usage.view` | action |
| 运行 | `run.view`、`run.view.all`、`run.cancel`、`run.retry` | action |
| 审批 | `approval.view`、`approval.decide` | action |
| 开放平台 | `apikey.view`、`apikey.manage`、`quota.manage`、`webhook.manage` | action |
| 组织 | `org.view`、`org.manage`、`role.view`、`role.manage`、`policy.manage` | action |
| 权限 | `data_policy.view`、`data_policy.manage`、`service_account.manage` | action |
| 定时任务 | `schedule.view`、`schedule.manage`、`schedule.run` | action |
| 知识库 | `kb.view`、`kb.manage` | action |
| 评测 | `eval.view`、`eval.manage` | action |
| 安全 | `secret.manage`、`audit.view`、`settings.manage`、`sso.manage`、`connector.manage` | action |
| 菜单 | `menu.dashboard`、`menu.build`、`menu.runs`、`menu.open_platform`、`menu.governance`、`menu.settings` | menu |

规则：
- 权限码只增不改语义；废弃码保留一段时间并在代码中标记。
- 菜单权限是功能权限的一种，但仍需对应 action 权限才能执行操作。
- API 端点声明所需权限码；服务端中间件与领域服务双重校验。
- 控制台 `PermissionGate` 只做体验优化，不是安全边界。

### 3.2 角色权限矩阵

- 控制台「角色与权限 → 功能权限」以域分组展示勾选矩阵。
- 保存时计算 diff，写审计（前后值）；支持复制角色、重置为内置模板。
- 角色有 `revision`；并发修改冲突返回 409。
- 内置 `platform_admin` 固定全部权限，不允许编辑，避免锁死系统。
- 权限变更在下一次请求生效；已登录用户无需重新登录。
- 支持“预览角色视角”：选择角色显示可见菜单与操作（不实际切换身份）。

### 3.3 角色绑定

- 绑定主体：`user`、`group`；绑定作用域：`global`、`org`（含子树按配置）。
- 一个用户可有多个角色，权限取并集；数据权限取并集后再减去 deny。
- 组织管理员只能管理本组织及子树的绑定，不能授予超出自身范围的权限（防提权）。
- 绑定变更写审计；到期时间 P1。

### 3.4 服务账号

- 服务账号用于定时任务、Agent 入站服务身份、后台集成。
- 有独立角色与数据策略；不能登录控制台；可设置过期时间。
- 服务账号停用 → 其定时任务暂停、集成调用失败；不能冒用创建者身份。
- 控制台展示每个服务账号的绑定、最近使用、关联定时任务。

### 3.5 API App 的 Scope

- 开放平台应用使用 Scope（`agents:read`、`runs:create` 等），与功能权限码分离，避免外部 Scope 直接映射内部权限。
- 应用数据范围默认 `app`：只能读取自己创建的 Run/Thread/File/Artifact。
- 管理员不能通过 Scope 让应用读取其他应用数据；需要跨应用数据时走服务账号或管理员导出。

## 4. 数据权限

### 4.1 资源与动作

| 资源类型 | 动作 | 说明 |
| --- | --- | --- |
| `agent` | read | Agent 列表/详情可见性（仍受 `agent_bindings` 约束） |
| `run` | read, export | Run 元数据、状态、用量；导出结果 |
| `message` | read | 会话消息正文；可与 run 分离，支持审计角色只看元数据 |
| `tool_call` | read | 工具参数/结果（脱敏后） |
| `artifact` | read | 产物下载 |
| `file` | read, delete | 上传文件 |
| `thread` | read, write, delete | 多轮会话 |
| `knowledge_base` | read, write | 知识库与文档 |
| `schedule` | read, write, run | 定时任务 |
| `audit_log` | read, export | 审计日志 |

**派生归属**：`message`、`tool_call`、`artifact` 通过 `run_id` 归属；`file` 通过 `owner_type/owner_id`；`agent` 通过 `owner_org_unit_id`；`thread` 使用自身 `org_unit_id` 与 `subject_id`。Repository 查询派生资源时必须 join 到归属记录，不能只按资源 ID 信任。

数据权限不替代功能权限：先有 `run.view` 等功能权限，再按数据策略过滤行；先有 `kb.view`，再按数据范围过滤知识库。

### 4.2 数据范围类型

| 类型 | 含义 | 配置 | 示例 |
| --- | --- | --- | --- |
| `all` | 全部数据 | 无 | 平台管理员、审计负责人 |
| `org_tree` | 指定组织及所有子部门 | `orgId` | 销售总监看销售部及下属 |
| `org` | 仅指定组织，不含子部门 | `orgId` | 部门管理员 |
| `custom_orgs` | 指定多个组织（可跨层级） | `orgIds[]` | 项目组跨部门 |
| `self` | 本人创建/触发 | 无 | 普通用户 |
| `app` | 当前 API 应用自身 | 无 | 开放平台应用 |
| `service_account` | 指定服务账号自身 | 无 | 后台任务 |
| `none` | 无数据 | 无 | 显式拒绝 |
| `attribute` | 按资源属性/声明匹配 | P1 | 项目 ID、客户 ID、地区 |

组织范围在请求时展开为组织 ID 集合；组织树变更后缓存失效。`self` 使用资源上的 `subject_type`/`subject_id`（或 `created_by`），不是当前登录用户名。

### 4.3 策略模型

```
功能角色 ──< data_policies >── 数据范围
    │                              │
    └─ role_bindings ─ user/group  └─ org / self / app ...
                │
                └─< principal_data_grants >（例外授权/拒绝）
```

- `data_policies`：角色 + 资源类型 + 动作集合 + 范围 + 效果（allow/deny）+ 优先级。
- `principal_data_grants`：针对用户/服务账号的例外 allow/deny，可设置过期时间（P0 支持 allow/deny，过期 P1）。
- `resource_grants`（P1）：单条资源分享给指定用户/组，例如共享一个 Run。
- **deny 优先**：任一适用 deny 即拒绝，除非是平台管理员且显式豁免（默认不豁免）。
- **并集**：多个 allow 取并集；范围 `all` 吸收其他范围。
- **作用域**：角色绑定到组织时，数据策略仍按策略自身的范围计算；绑定作用域限制的是“管理权限”，不是自动数据范围。避免“组织管理员天然看全部数据”的误解。
- **外部上限**：Agent Principal 的 `dataScope`、API App 的 `app` 范围作为上限，与本地策略取交集。

### 4.4 评估算法

输入：`AccessContext { subject, functionalPermissions, roles, orgIds, dataPolicies, requestId }`。

```
1. 功能权限检查：无所需 permission → 403
2. 收集适用数据策略：
   - 主体直接绑定 / 组继承 / 服务账号角色
   - 排除过期授权
3. 若有任一 deny 命中（资源类型+动作+范围）→ 拒绝
4. 合并 allow：
   - all → 无行级限制
   - org/org_tree/custom_orgs → org_unit_id IN (...)
   - self → subject_id = 当前主体（或 created_by）
   - app → app_id = 当前应用
   - service_account → subject_id = 当前服务账号
5. 与外部上限取交集（Agent Principal dataScope / API App app）
6. 生成 QueryFilter，交给 Repository
7. 详情/下载/SSE 再执行一次资源级检查，防止 ID 猜测
```

`AccessContext` 由 `packages/governance` 生成，缓存于请求作用域；禁止业务代码自行拼接权限条件。

### 4.5 强制点

| 入口 | 强制方式 |
| --- | --- |
| 管理 API 列表 | Repository 必须接收 `QueryFilter`；无过滤参数的查询编译期/测试失败 |
| 管理 API 详情 | `assertCanRead(resource)`；不存在与无权限统一 404 |
| 开放 API | 应用范围 `app`；Run/Thread/File 查询带 `app_id` |
| 集成 API | Principal 签名 `dataScope` ∩ 本地策略 |
| SSE | 订阅前检查 Run 可见性；事件中不泄露不可见资源 |
| 文件/Artifact | 元数据检查通过后才签发短期 URL；对象存储私有 |
| 知识库检索 | 检索前过滤 `kb_id`/组织；向量结果再次按文档权限过滤 |
| 工具调用 | 只允许策略快照中的工具；外部数据范围通过 Connector `dataScope` 传递，目标系统最终执行 |
| 导出 | 单独 `export` 动作；异步导出再次校验并审计 |
| 审计日志 | `audit.view` + `audit_log` 数据范围；默认平台管理员/审计角色 |
| 定时任务 | 以服务账号身份运行，使用其数据范围；创建者停用不影响服务账号，服务账号停用则暂停 |

**SQL 示例**（Repository 内部生成，不拼接用户输入）：

```sql
SELECT id, status, agent_id, created_at
FROM runs
WHERE org_unit_id IN (:allowedOrgIds)
  AND (subject_type = 'user' AND subject_id = :subjectId)
ORDER BY created_at DESC, id DESC
LIMIT :limit;
```

禁止：
- 在 Controller/Service 里手写 `WHERE org_id = ...` 绕过统一过滤。
- 用前端传入的 `orgId` 直接查询。
- 先查全量再在内存过滤（既慢又容易漏）。
- 对无权限资源返回 403 暴露存在性；统一 404。

### 4.6 字段级脱敏（P1）

- 规则：资源类型 + 字段路径 + 角色/主体 + 脱敏方式（掩码/截断/哈希/移除）。
- 在序列化层执行，不修改数据库原文；日志与导出同样应用。
- 典型字段：手机号、邮箱、身份证、客户姓名、金额、工具返回的敏感字段。
- 规则变更写审计；提供预览。

### 4.7 单条资源共享（P1）

- `resource_grants`：资源类型 + 资源 ID + 主体 + 动作 + 过期时间。
- 仅允许资源所有者或有 `share` 权限的角色分享；不可分享给外部应用。
- 分享不扩大功能权限；对方仍需拥有对应功能权限。
- 分享记录进入审计；可撤销。

### 4.8 属性级/ABAC（P2）

- 当 `custom_orgs` 无法表达时（项目、客户、地区、数据分类），引入属性策略。
- 资源打标签（`projectId`、`customerId`、`classification`），策略用受限表达式匹配。
- 不使用任意代码表达式；采用白名单操作符与字段，避免注入与不可解释授权。
- 提供“为什么可见/不可见”的解释结果。

## 5. 默认策略示例

| 角色 | 功能权限 | 数据范围 |
| --- | --- | --- |
| `platform_admin` | 全部 | `all` |
| `org_admin` | 本组织 Agent/用户/定时任务管理 | `org_tree`（本组织）；审计只读本组织 |
| `builder` | Agent/Skill/MCP/工具/模型配置与发布 | `org_tree` 的 Run 只读；`self` 的草稿 |
| `operator` | 运行查看/取消/审批 | `org_tree` 的 Run；`message` 按需只读 |
| `auditor` | 审计、用量只读 | `all` 的 Run 元数据与审计；`message` 默认拒绝（需要时单独授权） |
| `user` | 使用被授权 Agent | `self` 的 Run/Thread/File |
| 定时任务服务账号 | `agent.run` + `schedule` 执行 | 创建时指定 `org_tree`/`custom_orgs` |
| API App | 申请到的 Scope | `app`（仅自身数据） |

示例：
- 销售部用户只能看到自己发起的 Run；销售总监看到销售部及子部门所有 Run；审计员能看到全部 Run 元数据但看不到消息正文。
- 某服务账号被授予 `org_tree:销售部`，其定时任务生成的 Run 归属销售部；其他部门不可见。
- API App 只能读取自己创建的 Run，即使两个应用属于同一组织。

## 6. 控制台

### 6.1 页面

| 路由 | 内容 |
| --- | --- |
| `/roles` | 角色列表；新建/复制/删除 |
| `/roles/:id` | Tabs：功能权限矩阵、数据权限矩阵、成员绑定、变更历史 |
| `/data-scopes` | 数据范围列表与构建器（组织树、多选、self/app 说明） |
| `/permissions` | 功能权限目录（只读，按域分组） |
| `/service-accounts` | 服务账号列表、角色、数据策略、关联定时任务、最近使用 |
| `/org` | 组织树、用户、组 |
| `/access/preview`（或角色详情内） | 选择用户/资源，预览可见范围与拒绝原因 |

### 6.2 交互规则

- 功能权限矩阵：按域分组，全选/反选；保存前展示新增/移除；`platform_admin` 只读。
- 数据权限矩阵：资源 × 动作 × 范围；`deny` 用明显标识；冲突时提示“拒绝优先”。
- 范围构建器：组织树多选；`self`/`app`/`service_account` 有解释文案；不支持的类型置灰。
- 预览：选择用户 + 资源类型，显示有效角色、功能权限、数据范围、示例记录；不返回敏感正文。
- 变更审计：谁改了哪个角色/策略、前后值、时间；一键回滚 P1。
- 防提权：组织管理员只能授予自己拥有的权限子集与数据范围子集；服务端校验，前端提示。
- 删除角色/范围前检查引用；有绑定时阻止或要求迁移。

## 7. API 面

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/admin/v1/permissions` | 功能权限目录 | `role.view` |
| GET | `/admin/v1/roles` | 角色列表 | `role.view` |
| POST | `/admin/v1/roles` | 创建角色 | `role.manage` |
| PUT | `/admin/v1/roles/{id}/permissions` | 功能权限矩阵 | `role.manage` |
| GET/POST | `/admin/v1/role-bindings` | 角色绑定 | `role.manage` |
| GET | `/admin/v1/data-scopes` / `POST` | 数据范围 | `data_policy.view` / `data_policy.manage` |
| PUT | `/admin/v1/roles/{id}/data-policies` | 数据权限矩阵 | `data_policy.manage` |
| GET/POST | `/admin/v1/principal-data-grants` | 例外授权/拒绝 | `data_policy.manage` |
| GET/POST | `/admin/v1/service-accounts` | 服务账号 | `service_account.manage` |
| PUT | `/admin/v1/service-accounts/{id}/roles` | 服务账号角色 | `service_account.manage` |
| GET | `/admin/v1/access/preview` | 授权预览 | `data_policy.view` |
| GET | `/admin/v1/session` | 返回有效功能权限与数据范围摘要 | 登录用户 |

所有接口写审计；权限判断在服务端完成。详细字段见 [admin-api.md](../03-api/admin-api.md)。

## 8. 数据模型

见 [mysql-design.md](../04-data/mysql-design.md)：
- `permissions`、`roles`、`role_permissions`、`role_bindings`
- `data_scopes`、`data_scope_orgs`
- `data_policies`、`principal_data_grants`
- `service_accounts`、`service_account_roles`
- `resource_grants`（P1）
- `audit_logs`

关键约束：
- `data_policies` 唯一：`(role_id, resource_type, action, scope_id, effect)`。
- `data_scopes` 的 `type` 与 `config_json` 校验；组织范围必须引用存在的组织。
- `service_accounts.source_system_id` 关联 Agent 系统 ID；停用不可逆需审计。

## 9. 测试与验收

### 9.1 必测矩阵

- [ ] 功能权限：每个角色只能看到授权菜单；直接调用未授权 API 返回 403。
- [ ] 数据权限：跨组织用户无法读取/搜索/导出/下载他人 Run、消息、文件、Artifact。
- [ ] `self`：用户只能看到自己发起的 Run；被委派/共享的例外按策略。
- [ ] `org_tree`：父部门用户可见子部门；子部门用户不可见父部门。
- [ ] `custom_orgs`：仅列出的组织可见；组织删除后策略失效并告警。
- [ ] `deny`：显式拒绝优先于角色 allow；拒绝原因可在预览中解释。
- [ ] 详情/下载/SSE：通过猜 ID 无法绕过列表过滤。
- [ ] API App：只能读取自身数据；跨应用访问 404。
- [ ] 服务账号/定时任务：以服务账号范围运行；创建者停用/服务账号停用行为正确。
- [ ] 知识库：检索结果只来自有权文档；向量召回后再次过滤。
- [ ] 导出：无 `export` 动作拒绝；导出内容与预览范围一致；有审计。
- [ ] 权限变更：下次请求生效；会话中的旧权限不缓存；并发修改 409。
- [ ] 防提权：组织管理员不能授予自身没有的权限或超出自身的数据范围。
- [ ] 审计：权限/策略变更、敏感数据访问、拒绝均有记录。

### 9.2 工程约束

- Repository 所有 `list/find/export` 方法必须接收 `QueryFilter`；通过 lint/测试禁止无范围查询。
- 提供一个统一的 `AccessContext` 注入中间件；禁止从请求体读取主体身份。
- 数据权限单测使用固定组织树、角色、资源夹具；集成测试使用真实 MySQL。
- 每次新增数据资源类型，必须同时新增：策略矩阵、过滤字段、测试用例、控制台展示。
- 性能：组织范围展开缓存；`org_unit_id`、`subject_id`、`app_id` 建索引；避免 `IN` 列表过大（超过 1000 个组织时改用闭包表/临时表，P1）。

## 10. 阶段范围

**P0**
- 功能权限目录、角色矩阵、绑定、防提权。
- 数据范围 `all/org_tree/org/custom_orgs/self/app/service_account`。
- 数据策略、例外授权、拒绝优先、运行时强制、预览、审计。
- 服务账号与定时任务数据范围。
- 控制台权限页与预览。

**P1**
- 字段级脱敏、单条资源共享、授权到期、权限变更回滚、组织闭包表优化。
- 访问日志与“为什么可见”解释。

**P2**
- 属性级 ABAC、数据分类分级、动态脱敏、跨组织数据交换审批。

## 11. 需求映射

| 需求 | 覆盖 |
| --- | --- |
| FR-GV-01/02 功能权限与组织 | 第 3 节 |
| FR-GV-13 功能权限管理 | 第 3、6 节 |
| FR-GV-14 数据范围模型 | 第 4.2 节 |
| FR-GV-15 数据策略与冲突 | 第 4.3、4.4 节 |
| FR-GV-16 运行时强制 | 第 4.5 节 |
| FR-GV-17 授权预览 | 第 6.2 节 |
| FR-GV-18 字段脱敏 | 第 4.6 节（P1） |
| FR-GV-19 资源共享 | 第 4.7 节（P1） |
| FR-GV-20 权限审计 | 第 6、9 节 |
| FR-GV-21 服务账号/定时任务 | 第 3.4、4.5 节 |
| FR-GV-22~25 SSO/Connector | [sso-and-connector.md](sso-and-connector.md) |
