# Forge 全量测试用例

> **状态**：草案，待审查后执行  
> **冻结基线（推完后）**：`4c2555e`（含 `543b664` 控制台 + `GET /schedules/:id`）  
> **环境**：`http://127.0.0.1:3198`，库 `forge_ux`；开发库 `forge` 与 3100 不碰  
> **账号**：`~/forge-ux-3198-login.txt`（platform_admin）；角色矩阵账号在执行前由测试种子到 `forge_ux`，路径 `~/forge-qa-users.json`（chmod 600）  
> **编写**：测试工程师 · worktree `/Users/libo/projects/forge-qa-cases` · 分支 `qa/full-test-cases`  
> **接口底稿**：`docs/qa/api-inventory.md`（后端提供，已入库副本）

## 0. 约定

| 字段 | 含义 |
|---|---|
| ID | 稳定编号，审查与缺陷单引用此 ID |
| 类型 | 功能 / 边界 / 异常 / 接口 / 安全 / 样式 / 日志 / 运维 |
| P | P0 阻断 · P1 严重 · P2 一般 · P3 建议 |
| 预期 | 可核对的 pass 条件；未写「含堆栈」即不得出现堆栈 |
| 证据 | 截图路径或 `/tmp/forge-logs/…` |

**角色缩写**：PA=`platform_admin` · OA=`org_admin` · BL=`builder` · OP=`operator` · AU=`auditor` · US=`user` · OO=`other_org_admin`（另一部门的 org_admin）

**优先级规则**：登录/鉴权/跨部门隔离/密钥脱敏/CSRF = P0；主路径业务按钮 = P1；空态/文案/次要交互 = P2；观感微调 = P3。

**审查分工（请在本节末签名）**

| 章节 | 审查人 | 状态 |
|---|---|---|
| §1 功能（新/旧控制台） | 前端 + UX（Agent专家转交） | 待审 |
| §2 接口与错误码 | 后端（底稿 `api-inventory.md`） | 已审 `b7bfce9`（有遗漏 + 9 条错预期）→ 本轮已改，见 §14，待复审 |
| §3 安全 | 安全专家（Agent专家转交）；架构师审威胁模型 | 待审 |
| §4 样式 | 前端 + UX | 待审（前端审计 `~/forge-fe-shots/audit/` 已出 P1–P3，用例需对齐） |
| §5 日志与运维 | 运维补写细节后自审 | 待审 |
| 横向覆盖（角色×接口、状态机） | 架构师 | 待审 |

---

## 1. 功能用例

### 1.1 认证与会话（新 `/next/` + 旧 `/`）

| ID | 类型 | P | 前置 | 步骤 | 预期 |
|---|---|---|---|---|---|
| F-AUTH-01 | 功能 | P0 | 未登录 | 打开 `/next/` | 跳到 `/next/sign-in` |
| F-AUTH-02 | 功能 | P0 | 登录页 | 正确邮箱密码提交 | 进 Agents，侧栏可见，会话 cookie `HttpOnly; SameSite=Lax` |
| F-AUTH-03 | 异常 | P0 | 登录页 | 错误密码 | toast/文案「邮箱或密码错误」，不进系统；响应 401，消息与「邮箱不存在」相同 |
| F-AUTH-04 | 边界 | P1 | 登录页 | 空邮箱/空密码提交 | 前端拦或 400，焦点落在首个非法字段 |
| F-AUTH-05 | 功能 | P0 | 已登录 | 用户菜单 → 退出登录 → 取消 | 仍登录，焦点回用户按钮 |
| F-AUTH-06 | 功能 | P0 | 已登录 | 退出 → 确认 | cookie 清除，回登录页；再访问 `/admin/api/agents` → 401 |
| F-AUTH-07 | 功能 | P1 | 已登录 | 打开旧控制台 `/` | 同一会话可用，不要求重登 |
| F-AUTH-08 | 异常 | P1 | SSO 未配 | 点 OIDC 登录（若入口可见） | 503 SSO-1201，页面可理解 |
| F-AUTH-09 | 异常 | P1 | 已登录 | 清 cookie 后点需鉴权按钮 | 回登录，无白屏 |

### 1.2 新控制台 · Agents（`/next/agents`）

| ID | 类型 | P | 前置 | 步骤 | 预期 |
|---|---|---|---|---|---|
| F-AGT-01 | 功能 | P0 | PA 登录 | 打开 Agents | 列表展示名称/key/状态/版本；Tab「全部 / 有待发布草稿 / 已开放 API」计数正确 |
| F-AGT-02 | 功能 | P1 | 有草稿 | 点「发布 vX」→ 取消 / Esc | 弹窗关，焦点回发布按钮，未发布 |
| F-AGT-03 | 功能 | P1 | 有草稿 | 发布 → 确认 | 草稿变已发布，列表刷新，审计有 `agent.publish`（或等价 action） |
| F-AGT-04 | 功能 | P1 | API 关 | 开开放 API 开关 → 取消 | 状态不变，焦点回开关 |
| F-AGT-05 | 功能 | P1 | API 开 | 关开放 API → 确认 | 开关关闭，审计有记录 |
| F-AGT-06 | 功能 | P1 | 任意行 | ⋯ 菜单各项 | 每项文案与行为符合 DESIGN；「在旧版中查看」跳旧控制台对应 Agent |
| F-AGT-07 | 边界 | P2 | 列表 | Tab 筛到 0 条 | 空态文案，无报错 |
| F-AGT-08 | 功能 | P2 | 列表 | 搜索无结果（若有搜索） | 空态；清空恢复 |
| F-AGT-09 | 异常 | P1 | 发布中 | 断网或 5xx | toast 可读错误码/文案，不假成功 |
| F-AGT-10 | 功能 | P2 | `ux-draft-agent` / `mcp-agent` | 核对草稿角标 | 与接口 `draftVersion` 一致 |

### 1.3 新控制台 · 审批中心（`/next/approvals`）

| ID | 类型 | P | 前置 | 步骤 | 预期 |
|---|---|---|---|---|---|
| F-APR-01 | 功能 | P0 | 有待审 | 打开页 | 分页 `page/pageSize/total` 与接口一致；「共 N 条」正确 |
| F-APR-02 | 功能 | P0 | 假参数两条 | 看 `args_preview` | `api_key`/`Authorization`/`token`/`accessToken` 为 `***`；普通文本不打码；空串显示「无参数」 |
| F-APR-03 | 功能 | P0 | 任一行 | Run ID | 显示**后 8 位**；悬停 title=完整 ID；复制按钮写入完整 ID |
| F-APR-04 | 功能 | P0 | 普通审批 | 批准→取消 / Esc | 焦点回「批准」，总数不变 |
| F-APR-05 | 功能 | P0 | 普通审批 | 批准→确认 | 行消失，total−1，焦点到 h1；请求体 `decision=approved`；审计有 decide |
| F-APR-06 | 功能 | P1 | 待审 | 拒绝→确认 | 同上；请求体 `decision=rejected` |
| F-APR-07 | 功能 | P1 | total>pageSize | 翻到第 2 页再回第 1 页 | 数据与 `page=` 一致，无串页 |
| F-APR-08 | 边界 | P1 | — | pageSize 表现（UI 若可改）或接口夹紧 | UI 不出现 >100 的请求；见 I-APR-* |
| F-APR-09 | 功能 | P1 | 工具名含 `_` | 看单元格 | `whitespace-nowrap`，不在下划线处折行 |
| F-APR-10 | 样式 | **P3** | 桌面 ≥1024（表格布局） | 测审批表行高 | 审批行始终是两行内容，所以是 52（±1）。→ 映射 **UI-057**，不单独计 fail。备注：行高不影响功能，优先级与 UI-057 一致（P3）；前端 1440 宽度实测审批表 52、Agents 表 53 |
| F-APR-11 | 功能 | P0 | 系统「减少动态效果」 | 开关菜单/弹窗/⌘K/切页 | CSS 动画 ≤1ms；motion 直接终态（不透明度=1） |
| F-APR-12 | 异常 | P1 | 并发 | 两人同时批准同一条 | 一方成功，另一方可理解错误（非 500） |

### 1.4 新控制台 · 壳层与错误页

| ID | 类型 | P | 前置 | 步骤 | 预期 |
|---|---|---|---|---|---|
| F-SHELL-01 | 功能 | P1 | 已登录 | ⌘K / Ctrl+K | 命令板打开，可跳 Agents/审批 |
| F-SHELL-02 | 功能 | P2 | — | 切深色/浅色 | 两套主题完整，无未读 CSS 变量 |
| F-SHELL-03 | 功能 | P1 | — | 访问 `/next/not-a-page` | 404 页，可回首页 |
| F-SHELL-04 | 功能 | P2 | 模拟 | 触发 500 页（路由或开关） | 500 页文案可读，无堆栈 |
| F-SHELL-05 | 功能 | P1 | Agents↔审批 | 侧栏切换 | 页面切换 ≤180ms 量级；减少动态效果时无位移淡入 |

### 1.5 旧控制台（`/`，未迁移页必须测）

逐 Tab 打开：dashboard / agents / models / mcp / skills / tools / packages / runs / approvals / schedules / apps / users / sso。

**测试宽度（已定）**：F-LEG-* 只测桌面 **1280 和 1440**；手机端 **N/A**（旧页面将迁移，不在手机端记 fail），仅保留冒烟 F-LEG-M1。

| ID | 类型 | P | 前置 | 步骤 | 预期 |
|---|---|---|---|---|---|
| F-LEG-01 | 功能 | P0 | PA | 每个 nav Tab 点一遍 | 主列表/空态可渲染，控制台无 JS 未捕获异常 |
| F-LEG-02 | 功能 | P1 | PA | Agents：创建草稿→保存版本→发布→试运行（可用 mock 8090） | 全流程成功或明确失败原因 |
| F-LEG-03 | 功能 | P1 | PA | 运行中心：打开一条 succeeded / waiting_approval | 事件流或详情可见；可取消进行中的 run（若有） |
| F-LEG-04 | 功能 | P1 | PA | 审批中心：批准/拒绝 | 与新控制台数据一致 |
| F-LEG-05 | 功能 | P1 | PA | 定时任务：列表、启用/禁用、手动 run | 状态变化；跨部门对象不可见 |
| F-LEG-06 | 功能 | P1 | PA | 定时任务详情（新接口上线后） | 旧 UI 若无详情则记「未实现」；新控制台迁入后补 F-SCH-* |
| F-LEG-07 | 功能 | P1 | PA | 应用与密钥：建 key → 列表仅前缀 | 明文 key 只在创建响应出现一次 |
| F-LEG-08 | 功能 | P1 | PA | 用户：列表无 `password_hash`；改角色受 PA 限制 | 响应与文档一致 |
| F-LEG-09 | 功能 | P2 | PA | SSO 页 | 未配置时状态清晰 |
| F-LEG-10 | 功能 | P2 | PA | MCP/Skills/模型/工具源/能力包 | 各至少一条「打开列表 + 一次写操作或说明只读」 |
| F-LEG-11 | 异常 | P1 | — | 接口 403/404 toast | 不吞错、不白屏 |
| F-LEG-12、F-LEG-13 | 异常 | P1 | — | 旧控制台 Provider「测试连接」被拦 / MCP 编辑被拦 | 正文见 `fe-cases.md`（新控制台尚未迁这两页） |
| F-LEG-M1 | 冒烟 | P2 | — | 宽度 375 打开旧控制台 `/` | 能打开、不白屏，并能跳回新控制台 `/next/`（同时承接 UI-072 的 375 冒烟，UI-072 该部分不单独计 fail） |

### 1.6 定时任务详情（依赖 `4c2555e`，新 UI 未迁前以接口+旧 UI 为准）

| ID | 类型 | P | 前置 | 步骤 | 预期 |
|---|---|---|---|---|---|
| F-SCH-01 | 接口/功能 | P1 | 本部门 schedule | `GET /admin/api/schedules/:id` | 200，字段与列表项一致（含 `agent_name`） |
| F-SCH-02 | 接口 | P0 | OO 登录 | GET 根部门 schedule id | 404，体与「不存在」相同 |
| F-SCH-03 | 接口 | P0 | — | 随机 id | 404 |
| F-SCH-04 | 接口 | P1 | AU | GET | 403（无 `schedule.view`） |
| F-SCH-05 | 功能 | P2 | 新控制台迁入后 | 详情页各按钮 | 另开用例组 F-SCH-UI-*（迁移时补） |

### 1.7 状态机抽查（架构师横向）

| ID | 对象 | 覆盖流转 | P |
|---|---|---|---|
| F-SM-01 | Run | queued→running→succeeded / failed / cancelled / waiting_approval | P1 |
| F-SM-02 | Approval | pending→approved/rejected；过期（若有）；rejected 后再批准 → 409 状态不变（I-APR-37）；Run 在 waiting_approval 被取消后审批不可操作、decide 409（I-APR-38） | P1 |
| F-SM-03 | Agent 版本 | draft→published；开放 API on/off | P1 |
| F-SM-04 | Schedule | enabled↔disabled；manual run；失败计数（若展示）；**服务账号被改成 platform_admin 后**（PATCH 被拒则库内构造），已有定时任务在调度器自动触发时被**自动暂停**，记 **SCD-4804**（手动 run 为 409 SCD-4804，见 F-SCH-10b） | P1 |
| F-SM-04a | Schedule（挂 S-45） | active → paused：服务账号所属部门 / 上级部门被停用后调度器触发，自动暂停，记 SCD-4801；手动 run 409 SCD-4801 不改状态（= F-SCH-14） | P1 |
| F-SM-04b | Schedule（挂 S-45） | active → paused：未绑服务账号的老任务，存的用户被停用 / 删除 / 部门停用后调度器触发，自动暂停，记 SCD-4801；手动 run 409 不改状态（= F-SCH-15） | P1 |

---

## 2. 接口用例

> 完整 86 条路由以 `tests/fixtures/routes-baseline.txt` 为准（`4c2555e` 起）。后端 `api-inventory.md` 到位后，本表「权限 key」列与之对齐。  
> **矩阵符号**：✓ 允许（2xx/业务 4xx）· ✗ 403 · ◌ 404（跨范围）· — 未登录 401  
> **全局前置**：测写接口的 401、403、CSRF 时必须带合法 body（如 `{}`）——请求体在 CSRF 之前解析（`plugins/csrf.ts:7`），顺序保留；body 解析失败的正确行为见 I-CSRF-06（400 / 413 / 415，现状 500，K-09）。

### 2.1 全局接口规则

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| I-G-01 | 接口 | P0 | 无 cookie 调所有 `/admin/api/*`；写接口带合法 body（如 `{}`），否则 body 解析先失败（见 I-CSRF-06） | 401 AUTH-1001 |
| I-G-02 | 接口 | P0 | 篡改 `forge_session` 签名 | 401 |
| I-G-03 | 接口 | P0 | 过期会话 | 401 |
| I-G-04 | 接口 | P0 | 有会话但无/错 `X-CSRF-Token` 的 POST/PATCH | 403 POL-2001，message「CSRF Token 缺失或无效」；无会话时为 401 AUTH-1001（不是 403）。CSRF 先于权限检查，细分见 I-CSRF-01～05（`api-cases-addendum.md`） |
| I-G-05 | 接口 | P1 | GET 带错 CSRF | 仍 200（GET 不校验） |
| I-G-06 | 边界 | P1 | body > 2MB | **413**，无堆栈。**已知缺陷**（W-01a）：现状 500 SYS-9001（`plugins/errors.ts` 不看 `error.statusCode`），执行如实记 fail |
| I-G-07 | 异常 | P1 | `Content-Type: application/json` + 非法 JSON；另测空 JSON 体、不支持的 Content-Type | **400 CFG-8501**，无堆栈（不支持的类型目标 415）。**已知缺陷 K-01**：现状均 500 SYS-9001，执行如实记 fail |
| I-G-08 | 接口 | P1 | 每个写操作成功后 | `GET /admin/api/audit` 有对应 action（逐路由 action 见 I-AUD-01 / `route-exec-matrix.md`）。**已知缺陷 K-03**：6 个接口不写审计——`POST /auth/logout`、schedules enable / disable、open runs cancel、integration 建 Run / cancel；`user.update` 不记 status 变化 |
| I-G-09 | 接口 | P0 | 错误响应 | 无 `password`/`token` 明文、无 SQL、无绝对路径 |
| I-G-10 | 接口 | P1 | 公开：`/healthz` `/readyz` `/auth/config` `/open/v1/openapi.json` | 无需登录 |

### 2.2 审批分页边界

| ID | 类型 | P | 请求 | 预期 |
|---|---|---|---|---|
| I-APR-01 | 边界 | P1 | 无 page | `{items}` 最长 100，无 total 或按文档 |
| I-APR-02 | 边界 | P1 | `page=1&pageSize=20` | 有 total；items≤20 |
| I-APR-03 | 边界 | P1 | `pageSize=100` | 接受 |
| I-APR-04 | 边界 | P1 | `pageSize=101` | 夹紧到 100（文档已写） |
| I-APR-05 | 边界 | P1 | `page=0` / 负 / 非整数 | 400 CFG-8501 |
| I-APR-06 | 边界 | P1 | `pageSize=0` / 负 / `abc` | 400 |
| I-APR-07 | 安全 | P1 | `page=1' OR '1'='1` | 400 CFG-8501，不 500（后端已核对代码） |

### 2.3 `args_preview` 回归（已有 59 单测，执行期抽 API）

| ID | 类型 | P | 预期 |
|---|---|---|---|
| I-APR-10 | 接口 | P0 | 列表中假数据两条打码规则与 `tests/args-preview-edge.test.ts` 一致 |
| I-APR-11 | 接口 | P1 | 残缺 JSON 值整体 `***`；`[草稿] 周报` / `{名字} 你好` 原样 |
| I-APR-12 | 接口 | P1 | 打码规则（架构师定）：参数含 `max_tokens`、`input_tokens`、`output_tokens` 时**保留原值**；键名为单独的 `token` / `tokens` 时**打码**。审批列表 `args_preview` 与运行详情（修复 B 共用规则）各验一遍。现状待实测（后端称修复分支规则含 `tokens` 会误伤计数字段，待补小提交） |

### 2.4 角色 × 权限矩阵（抽样主路径；全量见 inventory）

对每个 `/admin/api` 路由，用 PA/OA/BL/OP/AU/US/OO 各调一次：

| ID | 覆盖 | P | 预期 |
|---|---|---|---|
| I-RBAC-01 | 权限矩阵 | P0 | **前置：所有写请求带本会话 `X-CSRF-Token`**（否则一律 403 CSRF，矩阵整体误判）。判定：无权限 → 403 message「角色缺少权限: <key>」；有权限 → **不出现** message 为「角色缺少权限: <key>」的 403（业务 403 如 OA 授 org_admin/PA「不能授予该角色」、OA 改他人 org_admin 不传 role 不算 fail；400 校验失败也可）。逐路由期望见 I-RBAC-10 |
| I-RBAC-02 | OO 对根部门 Agent/Run/Schedule/Approval | P0 | 列表不含；按 id：Agent GET/PATCH、Run GET/**cancel**、Schedule GET/PATCH、Approval **decide**（Run/Approval 无 PATCH 路由）→ 404，与打不存在 id 时**完全相同**（状态码、错误码、message）。decide 跨部门预期：404、与审批不存在相同错误码（**RUN-7001**，本轮不新开码，见 §15.4）、文案「**审批不存在**」，报错中不得出现 Run 名或 Run id。**已知缺陷**（W-03）：现状跨部门返回「Run 不存在」，可据此判断 id 是否存在，执行如实记 fail。其余 R-xxx 子路由见 I-RBAC-11 |
| I-RBAC-03 | US 调 `approval.decide` / `user.manage` | P0 | 403 |
| I-RBAC-04 | BL 调 `approval.decide` | P0 | 403 |
| I-RBAC-05 | AU 无 `schedule.view` | P0 | schedules GET 403 |
| I-RBAC-06 | OA 不能授 `platform_admin`/`org_admin` | P1 | 403 |
| I-RBAC-07 | `plugin.uninstall` / `service_account.*` / `sso.manage` / `role.view` | P1 | 仅 PA（或文档角色）允许；其余 403——**与 ROLE_PERMISSIONS 不一致处记缺陷** |

### 2.5 资源范围（已知风险，必须用例化）

| ID | 类型 | P | 步骤 | 预期（产品确认前按「应隔离」写，不符则 fail） |
|---|---|---|---|---|
| I-SCOPE-01 | 安全/接口 | P0 | OO：`GET /admin/api/users` | 仅本部门（含子部门）用户，只有 PA 看全局。**已知缺陷 K-05**：现状全局，返回全站（修复 A 已改，待复验）。【待 Cursor Jackson 拍板】 |
| I-SCOPE-02 | 安全/接口 | P0 | OO：`PATCH` 根部门用户 | 404，同不存在。**已知缺陷 K-05**：现状 200（修复 A 已改，待复验）。【待 Cursor Jackson 拍板】 |
| I-SCOPE-03 | 安全/接口 | P0 | OO：`GET /admin/api/dashboard` | 统计仅本部门（含子部门），只有 PA 看全局。**已知缺陷 K-05**：现状含全库。【待 Cursor Jackson 拍板】 |
| I-SCOPE-04 | 安全/接口 | P0 | OO：对根部门 `apps/:id/keys` POST | **403**，不建 key（架构师建议：apps 全局可读属设计，改根部门 app / key 属越权）。**已知缺陷 K-05**：现状 200 建出 key。【待 Cursor Jackson 拍板】 |
| I-SCOPE-05 | 接口 | P1 | OO：读 apps / skills / mcp / providers 列表与详情 | 架构师建议：**全局可读属设计**，200 可见即 pass，文档需写明。【待 Cursor Jackson 拍板】 |
| I-SCOPE-06 | 安全/接口 | P0 | OA（非根部门）：`PATCH` 根部门 app；对根部门 app 签发 key（`POST apps/:id/keys`）/ 改 key | **403**，不产生任何改动、不写成功审计（架构师建议：改根部门 app 或 key 算越权）。现状待实测（静态看为 200，同 K-05）。【待 Cursor Jackson 拍板】 |

### 2.6 Open / Integration

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| I-OPEN-01 | 接口 | P0 | 无 key 调 `/open/v1/agents` 与 invoke | 401 |
| I-OPEN-02 | 接口 | P0 | 错误/过期 key、格式错、应用停用 | 401，消息统一不枚举。**已知缺陷 K-02**（待安全专家定级）：现状 4 种文案「API Key 格式不正确 / 无效 / 已过期 / 应用已停用」 |
| I-OPEN-03 | 接口 | P1 | 合法 key 调已开放 Agent | 按文档 2xx |
| I-OPEN-04 | 接口 | P1 | `/integration/v1/*` 无凭证 | 401 |

### 2.7 接口清单勾选

**执行表已生成：`docs/qa/route-exec-matrix.md`**（86 行，源 `api-inventory.md` §1 + 后端审阅 A2 + `api-cases-addendum.md`）。每行至少：未登录、一拒绝角色、一允许角色、非法参数（若有 body）；签字前请后端复核。

---

## 3. 安全用例

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| S-01 | 安全 | P0 | CSRF 见 I-G-04 | 写操作无 token 拒绝 |
| S-02 | 安全 | P0 | Cookie 无 `HttpOnly` 则 fail；生产缺 `Secure` 记缺陷 | 开发环境 Secure 可关，需文档说明 |
| S-03 | 安全 | P0 | 登录错误消息统一 | 防用户枚举 |
| S-04 | 安全 | P0 | 登录爆破 20+ 次/分钟 | 应限流或锁定。**已知缺陷 K-07**：代码无任何限流/锁定 |
| S-05 | 安全 | P0 | Agent 名存 `<script>…`，新/旧 UI 展示 | 文本转义，不执行 |
| S-06 | 安全 | P0 | 审批 args 含脚本/HTML | 仅文本展示 |
| S-07 | 安全 | P0 | SQL 注入字符进 query/body | 400/转义，表还在 |
| S-08 | 安全 | P0 | `/next/../`、`%2e%2e` 路径穿越 | 不读仓库外文件 |
| S-09 | 安全 | P0 | 响应/审计/服务日志无口令、Bearer、`sk-`、`fsk_` 明文 | grep 抽查 |
| S-10 | 安全 | P1 | 安全响应头逐项检查：分别取 `/next/`、`/`、任一 `/admin/api` JSON 接口（如 `GET /auth/session`）的响应头，逐项记录有无与取值：① `Content-Security-Policy`；② `X-Content-Type-Options: nosniff`；③ `X-Frame-Options` 或 CSP `frame-ancestors`（至少其一）；④ `Referrer-Policy` | 四项均应存在且取值合理；**每缺一项单独记一条缺陷**（定级：架构师）。安全专家代码核对：`app.ts` 未注册 helmet，当前预期四项**全缺**，执行如实记 fail |
| S-11 | 安全 | P1 | CORS：浏览器跨站带 cookie 写 admin | 应失败 |
| S-12 | 安全 | P0 | IDOR：换 approval/run/agent id 跨部门 | 404 |
| S-13 | 安全 | P1 | 依赖扫描（安全专家） | 高危 0 或有缓解说明 |
| S-14 | 安全 | P1 | 会话仅内存 Map：重启后 cookie 失效 | 符合设计；多实例粘滞风险记文档 |

---

## 4. 样式与响应式

断点：**375 / 390 / 768 / 1023 / 1024 / 1280 / 1440**；主题：浅 + 深。卡片 / 表格分界为 **1024**（<1024 卡片，≥1024 表格；原写 768 已改）。**不测 414**（UX 口径：有意去掉，390 代表大屏手机）。触屏尺寸口径：`pointer: coarse` 下输入框和主按钮视觉高度 44，图标按钮、开关、复制按钮外观不变、点击区扩到 44；768 归触屏档（UI-054）。

> **U-01～U-10 与 UI-050～064 重复**：执行以 UI 编号为准，下表 U 编号**只留映射行，不单独计 fail**。U-01～U-06 / UI-050～058 预期写正确行为，修复 `04ef9a8`（`fe/responsive`）进入基线后执行，结果按实测记，不预置 pass。  
> 已知例外（不记 fail）：tabs 的 3px 内边距、shadcn 的 -1px 外边距、只给读屏用的隐藏文字（sr-only）。

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| U-01 | 样式 | P1 | 390/768/1023 Agents、审批表 | 主操作（发布/开关/批准）首屏可达，无需盲横滑；<1024 为卡片布局 → 映射 **UI-050**，不单独计 fail |
| U-02 | 样式 | P1 | 768 | 侧栏默认图标模式或可收起，不吃掉 1/3 内容区 → 映射 **UI-051**，不单独计 fail |
| U-03 | 样式 | P2 | 触控目标 | 触屏（375/390/768，hasTouch）≥44px；桌面 1280/1440 复制/关闭 ≥24px → 映射 **UI-053 / UI-054**，不单独计 fail |
| U-04 | 样式 | P2 | 浅色 `muted-foreground` | 对比度 ≥4.5:1（axe） → 映射 **UI-055**，不单独计 fail |
| U-05 | 样式 | P3 | ⌘K 提示字号 | ≥12px → 映射 **UI-056**，不单独计 fail |
| U-06 | 样式 | P3 | favicon | 无 404 → 映射 **UI-058**，不单独计 fail |
| U-07 | 样式 | P3 | Tab padding 3px | Tabs 的 3px 内边距是 shadcn 自带样式，记为已知例外，不记 fail；前提：触屏下 Tab 点击区须 ≥44，按 **UI-054** 测（修复前实测 29；`04ef9a8` 加了 min-height 44）。**复验 44，pass（mock 实测）**：375 / 768 / 1023 下 Agents 页 3 个 Tab 触屏模拟高度均 44，computed min-height 44px → 映射 **UI-057**（间距）/ **UI-054**（点击区），不单独计 fail |
| U-08 | 样式 | P1 | 1440/1280 浅+深 | 间距抽查关键组件为 4 的倍数；无意外重叠 → 映射 **UI-052 / UI-057**，不单独计 fail |
| U-09 | 样式 | P1 | 减少动态效果 | 同 F-APR-11 → 映射 **UI-062**，不单独计 fail |
| U-10 | 样式 | P1 | 5 个确认弹窗焦点归还 | Esc/取消/确认（行消失→h1） → 映射 **UI-060 / UI-061**，不单独计 fail |

截图目录约定：`~/forge-fe-shots/full-qa/{route}/{viewport}-{theme}.png`

---

## 5. 日志与运维（已由 OPS-001～023 承接，见 §11；下表保留交叉引用）

| ID | 类型 | P | 步骤 | 预期 | 负责人 |
|---|---|---|---|---|---|
| O-01 | 运维 | P0 | 缺 `FORGE_ADMIN_PASSWORD` / `SESSION_SECRET` 启动 | 明确报错退出，非挂起 | 运维补命令 |
| O-02 | 运维 | P0 | 错误 `DATABASE_URL` | 失败退出或 readyz 非 200 | 运维 |
| O-03 | 运维 | P1 | 端口占用 | 可理解错误 | 运维 |
| O-04 | 运维 | P1 | `.env` 缺字段 | 列出缺项 | 运维 |
| O-05 | 日志 | P0 | 制造 401/403/500 | 结构化日志；**无口令/token** | 运维 |
| O-06 | 日志 | P1 | 日志轮转/路径 | 落在约定目录 | 运维 |
| O-07 | 运维 | P1 | DB 断开时 `/healthz` `/readyz` | 文档化状态码 | 运维 |
| O-08 | 运维 | P1 | 重启 API | 会话存进程内存，重启后全部失效属**设计行为**：页面跳登录页，写操作不成功（401、无副作用）；定时任务恢复策略符合设计（同 OPS-012） | 运维 |
| O-09 | 运维 | P2 | `build:console` 体积基线 | 记录 JS/gzip；对照 1036KB | 运维 |
| O-10 | 运维 | P2 | 首屏时间 | 3198 `/next/` 冷/热 | 运维 |

---

## 6. 执行与缺陷流程

1. Cursor Jackson 确认用例无重大遗漏。  
2. 运维推送冻结 `main`（`4c2555e`）。  
3. 测试灌 `forge_ux` 种子 + 角色账号；前端冻结 4176/3198 构建。  
4. 分角色执行；缺陷表字段：`ID / 严重程度 / 复现 / 证据 / 负责人 / 状态`。  
5. P0/P1 修完回归对应 ID；P2/P3 汇总给 Cursor Jackson 拍板。  
6. 测试出总报告 `docs/qa/full-test-report.md`。

---

## 7. 待确认问题（阻塞用例预期的产品点）

| # | 问题 | 需要谁 | 清单依据 |
|---|---|---|---|
| Q1 | apps / skills / mcp / providers / audit / dashboard / users 标「全局」：是设计还是缺陷？OO 改根部门 app/key 算不算越权？**架构师建议**：apps/skills/mcp/providers 全局可读属设计，改根部门 app/key → 403；users/audit/dashboard 按本部门 + 子部门过滤，仅 PA 全局，现状记缺陷。【待 Cursor Jackson 拍板】 | 架构师 → Cursor Jackson | inventory §0.5、§4.C.20、可疑点 3 |
| Q2 | org_admin 可否把用户 `dataScope` 设成 `all`？可否 PATCH 其他部门用户（含降级 PA）？ | 架构师 | 可疑点 1、2 |
| Q3 | 本地登录是否必须限流/锁定？ | 安全 + 架构师 | inventory #7「无限流」 |
| Q4 | `service_account.manage` / `sso.manage` / `role.view` / `org.view` / `package.view` / `plugin.uninstall` 仅 PA：是否故意？ | 后端 + 架构师 | inventory §3 |
| Q5 | 旧控制台哪些 Tab 本轮必须全量点 vs 冒烟即可？ | Agent专家 / Cursor Jackson | — |
| Q6 | `/integration/v1` 无权限、不写审计、可列全部已发布 Agent：是否接受？ | 架构师 + 安全 | 可疑点 4 |
| Q7 | Run 详情 `toolCalls[].args` 不打码：是否只允许 PA，还是应对所有角色套 args_preview？ | 架构师 | 可疑点 + §4.D.25 |
| Q8 | 文档 `/admin/v1`+Bearer vs 代码 `/admin/api`+Cookie：本轮验收以代码为准，还是要改文档/改实现？ | 架构师 | §4.A |

---

## 8. 接口清单驱动的补强用例（合入 `api-inventory.md`）

底稿：`docs/qa/api-inventory.md`（从 `/tmp/forge-logs/api-inventory.md` 拷入，静态读 `935f8f5`/`4c2555e` 代码）。执行时以冻结 `main` 为准。

### 8.1 审批决定取值（纠正初稿）

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| I-APR-20 | 接口 | P0 | `POST .../decide` body `{"decision":"approve"}` | 400 CFG-8501（代码只认 `approved`/`rejected`） |
| I-APR-21 | 接口 | P0 | `decision=approved` 成功后再决定一次 | 409 CFG-8503，非幂等；非 APR-2103 |
| I-APR-22 | 功能 | P0 | 新控制台点「确认批准」 | 实际发出 `approved`（抓网络） |

### 8.2 可疑点 → 用例（未定级前暂标 P0/P1，架构师确认后可降）

| ID | 对应可疑点 | P | 步骤 | 预期（产品确认前按「应拒绝」） |
|---|---|---|---|---|
| S-20 | #1 dataScope 提升 | P0 | OA：`POST /users` 带 `dataScope:"all"`；再 `PATCH` 把 org 用户改成 all | 应 400/403；若 200 → 缺陷 |
| S-21 | #2 跨部门改用户 | P0 | OA：`PATCH` 其他部门用户 / 把 PA 改成 `role:user` | 应 403/404；若 200 → 缺陷 |
| S-22 | #3 跨部门 apps/keys | P0 | OO：读/改根部门 app、签发 key、replay webhook | 读：200（apps 全局可读属设计）；改 app / 签发 key / replay → **403**，无副作用（架构师建议）。**已知缺陷 K-05**：现状写操作 200。【待 Cursor Jackson 拍板】 |
| S-23 | #4 integration | P0 | 合法 Connector JWT（映射普通用户）调 `GET /integration/v1/agents`、`POST .../runs` | 记录实际可见范围与是否写审计；默认预期：应按映射用户数据范围限制且写审计——不符则缺陷 |
| S-24 | #5 app token 调 admin | P1 | `Authorization: Bearer fsk_…` 调 `GET /admin/api/runs` | 401 AUTH-1001（不认 Bearer） |
| S-25 | #6 参数 500 | P1 | `runs?limit=abc/1.5`、`audit?limit=-1/1.5/abc`、坏 JSON、3MiB body、非法 cron 且 active；6 处撞唯一键：apps key、users username、agent version、skill version、model key、schedule key；cron 非法不带 status（I-ERR-22） | 400 / 409，不 500。**已知缺陷 K-08**：上述现状 500 SYS-9001（cron 不带 status 直接入库） |
| S-26 | #7 报错泄露 | P1 | MCP create 失败、provider test 失败 | 响应 `warning`/`error` 不应含内网地址/SQL；日志可有完整错误但无口令 |
| S-27 | #8 审计缺口 | P1 | enable/disable schedule、open/integration cancel、integration 建 run | 成功后 audit 应有记录——无则缺陷或改文档 |
| S-28 | #9 会话不失效 | P0 | PA 停用某用户后，该用户旧会话调 API | 401。**已知缺陷 K-04**：会话为登录时内存快照，8h 内仍 200。扩展场景见 **S-45** |
| S-29 | #10 plugin 部分写入 | P1 | install 缺顶层 key（先建子资源） | 应事务回滚或补偿；残留无审计 → 缺陷 |
| S-30 | #10 OIDC returnTo（开放重定向） | **P1** | `/auth/oidc/login?returnTo=` 依次取：`//evil.example`、`/\evil.example`、`/%2F%2Fevil.example`、`https://evil.example`、`/%09/evil.example`（控制字符）；完成 OIDC 登录看最终跳转 | 一律**回落到 `/next/`**，不跳外域。规则（修复 R）：必须以单个 `/` 开头，拒绝 `//`、`/\` 和控制字符；再以本站 origin 为 base 解析，origin 必须等于本站。**已知缺陷 K-14（P1）**：现状 `//` 开头被放过（`auth.ts:54,67`） 新控制台登录页的跳回参数统一为 **`redirect`**（架构师裁定）；后端 302 到 `/next/sign-in` 前按本条规则校验，不合法不带。`/auth/oidc/login` 自身入参名以代码为准：`6656f9f` 里仍是 `returnTo`（`apps/api/src/routes/auth.ts:79` `safeReturnTo(query.returnTo, …)`）。前端登录页 `redirect` 的同类校验见 **UI-096** 前端登录后跳回二次校验（`80a2a27`）的用例见 UI-096；SSO 入口不接收回跳参数为已知缺陷 K-18（UI-097） |
| S-31 | Run 详情不打码 | P0 | builder/auditor/user 调 `GET /runs/:id` 含敏感 tool args | 应打码或 403；原文暴露 → 缺陷 |
| S-32 | 登录时序 | P2 | 邮箱不存在 vs 密码错误的耗时 | 记录差值；过大则记建议 |

### 8.3 文档 vs 代码（验收口径）

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| I-DOC-01 | 接口 | P2 | 抽查 10 条 admin 路径 | 实际为 `/admin/api`；文档差异记「文档债」，不挡功能 pass |
| I-DOC-02 | 接口 | P1 | 错误体字段 | 有 `retryable`，无 `remedy` |
| I-DOC-03 | 接口 | P1 | 创建类 POST | HTTP 200（非 201）。例外：`POST /open/v1/agents/:key/runs` → 202；`POST /integration/v1/runs` → 202；`POST /open/v1/agents/:key/invoke` Run 已结束 → 200、未结束 → 202；Idempotency 重放 → 200 |
| I-DOC-04 | 接口 | P2 | 文档有、代码无的码（APR-2103 等 11 个） | 不出现在响应；报告列「仅文档」 |
| I-DOC-05 | 接口 | P1 | 仅 PA 的 6 个权限 key | OA/BL 调对应接口 → 403；与 ROLE_PERMISSIONS 表一致即 pass |

### 8.4 数据范围细则

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| I-SCOPE-10a | 接口 | P1 | 统一规则（架构师定）：**本部门 + 所有子部门**。父部门用户 GET 子部门 Run（`/admin/api/runs/:id`、列表） | 200，可见 → pass |
| I-SCOPE-10b | 接口 | P1 | 同一父部门用户 GET 子部门 schedule（`/schedules/:id`、列表） | **200**，可见。**已知缺陷**：R-sched 精确等于，现状 404，执行如实记 fail |
| I-SCOPE-10c | 接口 | P1 | R-sa（SA 接口仅 PA，故经 schedule 绑定验证）。**正**：父部门 OA 创建/PATCH schedule 绑定**子部门**服务账号；**反**：绑定**兄弟部门**或**上级部门**服务账号。**前置（子部门 SA 怎么造）**：建服务账号时部门固定取调用者自己的部门，接口无法把 SA 放到别的部门（后端对过 `4c2555e`）。造法：① 用 PA 正常建好 SA；② 由**运维**在 **3196 的临时库 `forge_ops`** 执行 `UPDATE service_accounts SET org_unit_id=<子部门id> WHERE id=<账号id>`；③ 执行前先 `SHOW CREATE TABLE service_accounts` 核对表名和列名；④ 改之前先导出这张表做备份，SQL 原样贴进执行日志；⑤ 只允许在临时库（`forge_ops`，或 connector 场景的 `forge_connector`）上做，**禁止在 `forge`、`forge_ux` 上做**，测完整库删除。反面用例（兄弟部门 / 上级部门 SA）用同样办法造数据 | 正：**200**。**已知缺陷**：R-sa 精确等于，现状 404（修复 D 已改）。反：**404**，与 `serviceAccountId` 不存在时完全相同（状态码、错误码、message），响应中**不出现账号名**（= I-SA-10） |
| I-SCOPE-11 | 接口 | P1 | `self` 用户看 Agent 列表 | 与 `org` 相同（按部门子树），不是「仅自己创建」 |
| I-SCOPE-12 | 接口 | P1 | owner=NULL 的 Agent：列表空部门用户 vs 详情 | 列表/详情一致性；不一致记缺陷 |
| I-SCOPE-13 | 接口 | P1 | 修复 **AB**（`orgSubtreeIds` 用 `LIKE path%`）。建两个兄弟部门，key 分别为 `a_b` 和 `axb`；用 `a_b` 的 org_admin 读取 `axb` 下的用户（`GET /admin/api/users/:id` 或等价详情）、再看用户列表和审计列表 | 读 `axb` 的用户 → **404**，与不存在相同；列表和审计都看不到 `axb` 的数据。扩展：`a%` 对 `azz`、`q\` 对 `q\x` 同样不得串。备注：修法是转义 `\`、`%`、`_` 并在末尾拼接分隔符，或改用 `LEFT` 做前缀比较；**全仓库所有用 LIKE 拼路径的地方一并修改**。已修：AB `2244dbb` |
| I-SCOPE-14 | 接口 | P1 | 修复 **AB**。部门路径 `/a/b` 与 `/a/bc` 互为前缀，另建真正的子部门 `/a/b/c`；用 `/a/b` 的 org_admin 看用户列表、审计列表 | 看不到 `/a/bc` 的数据；能看到本部门和 `/a/b/c` 的数据，且 `/x/b/c` 这类真正子部门的资源**可见可改**。扩展：部门 key `a%` 不得匹配 `azz`；`q\` 不得匹配 `q\x`。备注同 I-SCOPE-13（修复 AB `2244dbb`：`path = ? OR path LIKE ? ESCAPE '!'`，转义 `!` `%` `_` 并末尾拼 `/`） |
| I-SCOPE-15 | 接口 | P1 | 修复 **AB**（`getActiveUserById` / `getActiveServiceAccountById` 原用 `LEFT(...)=` 前缀比较）。部门 `/x/b` 与 `/x/bc` 互为前缀，各有一个用户（及一个 SA 绑定的定时任务）；停用 `/x/b` | `/x/b` 下的用户下一次请求 401、SA 任务被暂停；**`/x/bc` 下的用户和 SA 不受影响**（请求照常 200，任务照常触发）。`/x/b/c`（真正子部门）随 `/x/b` 一起判为停用 |

### 8.5 执行表

已生成 **`docs/qa/route-exec-matrix.md`**（86 行：# / METHOD path / 权限 / 已有用例 / 缺口摘要 / 计划新用例 / 执行勾选），替代原计划的 `api-execution-sheet.md`。逐角色期望 = I-RBAC-10。

---

## 9. 前端用例合入（UI-001～UI-092）

完整底稿：`docs/qa/fe-cases.md`（前端提供）。与 §1/§4 重叠时**以 UI 编号为执行主编号**，F-/U- 作为交叉引用。

| 说明 | 处理 |
|---|---|
| UI-001 预期「跳转仪表盘」 | 新控制台登录后默认进 `/next/agents`（无独立仪表盘页）→ 预期改为「进入 Agents 或已实现的落地页」，记 **UI-001'** |
| UI-021 Agents 分页 | 代码列表无分页（inventory）：造 0/1/大量条测滚动/空态；「每页条数」若 UI 无控件则标 N/A |
| UI-025 Agents 详情 | `/next` 若尚未做详情路由，则「旧控制台详情 + ⋯菜单跳转」满足即 pass，缺页记缺口 |
| UI-032 | 同时覆盖审批预览打码 **与** 运行详情（旧控制台 Run）敏感字段；与 S-31 捆绑，任一侧明文即 fail |
| UI-034 / UI-081 | 执行编号为 **UI-081a / UI-081b**（UI-034 本身不拆号，按 UI-081a/b 判定）。拆 a/b：**a.** 审批已被清理为 expired → 批准 409 CFG-8503；**b.** 已过 `expires_at` 但未被 `timeoutApprovals` 清理 → 预期 409、不能批准。**已知缺陷**（W-06 / I-APR-36）：b 现状 200 批准成功，执行如实记 fail |
| UX 批次（`~/forge-baseline/ux-cases.md`） | 改 UI-053/054（768 归触屏档）、UI-055（axe 全断点 + 展开态，0 violation）、UI-056（字号字重，升 P2）、UI-057（全断点间距 + 误报排除 + 行高 44/52）；新增 UI-059、UI-065～069、UI-072～074。编号与 UI-083～092 无冲突，未重排。去重：UI-072 的 375 冒烟 → **F-LEG-M1** 执行；UI-073 → 映射行（由 UI-050 + UI-088 执行）；UI-089 → 映射行（由 UI-069 执行）。均标「不单独计 fail」。行高按 UI-057 通用规则（一行 44、两行 52，±1px 边框），F-APR-10 改为映射行 |
| UI-050～058 | 依赖 `fe/responsive` 修复。预期写**正确行为**；修复 `04ef9a8`（`fe/responsive`）进入基线后执行，结果按实测记，不预置 pass / fail。卡片 / 表格分界 1024；已知例外（不记 fail）：tabs 的 3px 内边距、shadcn 的 -1px 外边距、只给读屏用的隐藏文字（sr-only） |

执行清单（按模块）：UI-001～006 登录会话 · UI-010～014 导航 · UI-020～025 Agents · UI-030～034 审批 · UI-040～043 通用异常/XSS · UI-050～059 响应式样式（含 UI-059 对齐）· UI-060～064 无障碍动效 · **UI-065～069 UX 补充**（空/载/错态、长文本、手机弹窗抽屉、交互状态、缩放重排）· UI-070～071 主题兼容 · **UI-072～074 UX 补充**（旧版样式、手机表格呈现、API 不可用横幅）· **UI-083～092 前端审阅补充**（双击防重、分页回退与边界、toast、弹窗与后退、1023/1024、200% 缩放、横屏、侧栏图标读屏、会话过期弹窗；明细见 `fe-cases.md`）。

## 10. 威胁清单映射后的新增用例

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| S-33 | 安全 | P1 | 登录前记下匿名 cookie（若有）；登录成功后再看 `forge_session` | 登录后 token 与登录前不同（防固定） |
| S-34 | 安全 | P1 | Connector 开关关：带任意 Bearer 调 `/integration/v1/agents` | 503 CON-4703（或文档码） |
| S-35 | 安全 | P1 | 开关开：签名有效但映射用户无 `agent.run`，`POST /integration/v1/runs` | 403。**已知缺陷 K-06**：现状 202（= I-INT-11） |
| S-36 | 安全 | P1 | 有效调用 integration 写接口后查 audit | 应有记录；无则缺陷 |
| S-37 | 安全 | P2 | open 列表若含 cursor：篡改 cursor | 不可看到他应用数据 |
| S-38 | 安全 | P0 | 审计日志跨部门隔离：OA（本部门）或 AU 登录，库内已有他部门产生的审计记录；调 `GET /admin/api/audit?limit=200`，检查返回条目的 actor / resource 是否含其他部门 | 仅本部门及所有子部门，只有 PA 看全局；返回全站审计 → 缺陷（与 I-SCOPE-01/03 同口径）。**已知缺陷**：现状全局可见。【待 Cursor Jackson 拍板】 |
| S-39 | 安全 | P0 | MCP discover 出站（`POST /admin/api/mcp`、`POST /admin/api/mcp/:id/refresh`，BL/OA/PA）：白名单为空；`url` 依次设为回环 `http://127.0.0.1:<port>`、私网（10/8、172.16/12、192.168/16）、链路本地 `169.254.x.x`、云元数据 `http://169.254.169.254/...`；创建后再对已建记录调 refresh。受控监听端观察有无回连，只验证发起行为，不利用 | 统一出站校验：创建 / 修改 / refresh 均 **400 HTP-4003**，不发起连接；创建时的工具发现只记 warning 写 `last_error`；响应体不得出现解析出的 IP。**已知缺陷**：`discoverMcpTools` 未调 `assertSafeUrl`，现状会真实发起连接（= I-MCP-02） |
| S-40 | 安全 | P0 | Provider test 出站：BL/OA 建 provider，`baseUrl` 依次设为回环 / 私网 / 链路本地 / 云元数据地址并建一个模型，调 `POST /admin/api/providers/:id/test` | Provider 创建 / 修改 / test 均 **400 HTP-4003**（test 不再返回 `{ok:false}`）；不对目标发请求；响应体不得出现解析出的 IP。运行中被拦：不重试、换下一个候选，全部候选失败时 Run 以 HTP-4003 结束。**已知缺陷**：现状无私网校验 |
| S-41 | 安全 | P1 | 审计 details 明文敏感值：`PATCH /admin/api/mcp/:id` 带 `headers` 含 `Authorization: Bearer xxx`；`PATCH /schedules/:id` 带含密 `input`；`POST /role-mappings` 带整段 body；随后 `GET /admin/api/audit` 读 `mcp.update` / `schedule.update` / `role_mapping.upsert` | details 不原样保存 `headers_json` / `input_json` / 请求体中的密钥（应打码或不记）。代码确认当前原样存 → 缺陷（修复 B 已覆盖这三类，待复验）。只读验证，不外发 |
| S-42 | 安全 | P0 | Webhook 出站：OA/PA 建 app，`webhookUrl` 依次指向回环 / 私网 / 链路本地 / 云元数据地址；触发投递并调 `POST /admin/api/webhook-deliveries/:id/replay` | 配置 webhookUrl → **400 HTP-4003**；已存在的私网地址投递记 `failed`、不重试；replay → **200**，投递状态 `failed`；响应体不得出现解析出的 IP（投递记录存 errorCode 见 S-53）。代码此路径已有 `privateNetworkBlocked`，预期 pass，作回归；错误码与 S-39/S-40/S-46 一致（HTP-4003）。replay 的跨部门越权由 S-22 覆盖 |
| S-43 | 安全 | P1 | args_preview 已知限制向量（对照 `docs/03-api/admin-api.md` 第 9 节）：构造假数据审批，参数覆盖：① `https://app.test/cb#access_token=SECRET`；② `ex.com/a?token=SECRET`、`api.ex.com:8443/v1?key=SECRET`；③ `密码是 hunter2，token=abc123`、`use Authorization: Bearer abc`；④ `/cb？token=SECRET`（全角问号）；读审批列表 `args_preview` | 与文档「不打码」及 `tests/args-preview-edge.test.ts` 固定值一致 → pass，报告列为「已知打码盲区」交架构师决定是否收敛；出现文档未声明的新泄露 → 缺陷 |
| S-44 | 安全 | P0 | 生产默认密钥与 SSO 拒启（隔离临时实例，不碰 3198/3100）：(1) `NODE_ENV=production` + dev 默认 `SESSION_SECRET` / `FORGE_MASTER_KEY` / `API_KEY_PEPPER`；(2) `NODE_ENV=production` + `SSO_MODE!=required`；(3) 对照：production + 全部唯一密钥 + `SSO_MODE=required` | (1)(2) 启动即报错退出（"Production refuses development default secrets…" / "Production requires SSO_MODE=required"）；(3) 正常启动。补 O-01 只测「缺值」的缺口 |
| S-50a | 安全 | P1 | OIDC 出站·管理端 JSON 接口 | **无此接口**（架构师已确认）：系统没有管理端「测 OIDC 配置」的 JSON 接口，只有 `GET /admin/api/sso` 查状态；OIDC 被拦的 502 HTP-4003 由身份层单测覆盖（`packages/identity/src/index.ts:182` 注释所述路径）。本条不执行、不计 pass / fail |
| S-50b | 安全 / 前端 | P2 | OIDC 出站（修复 G + AD `6656f9f` + AE `f825dc9` + 前端 `57e7aa6` / `80a2a27`）·浏览器整页跳转：白名单为空，IdP 的 discovery / token / JWKS 指向回环 / 私网 / 元数据；从登录页点 SSO 登录，再直接访问回调地址；回跳值依次取合法路径 `/next/agents`、默认 `/next/`、不合法 `//evil.example`；另构造 `/next/sign-in?ssoError=<script>alert(1)</script>`、`ssoError=XYZ-0000`（未知码）、长度超过 64 的值，以及不带该参数 | 被拦时 **302**，`Location = /next/sign-in?ssoError=HTP-4003&redirect=<URL 编码的合法路径>`（例 `redirect=%2Fnext%2Fagents`）；`redirect` **先按 S-30 校验再编码**，不合法或等于 `/next/` 时**不带**；**任何情况都不输出 `returnTo`**；回跳值为 `//evil.example` 时 Location **只含 `ssoError` 一个参数**。不再返回 502 JSON。登录页显示固定文案「**单点登录暂不可用：身份提供方的地址被出站策略拦截，请联系管理员。**」；`ssoError=<script>` 或未知码只显示通用文案「单点登录失败，请稍后重试或联系管理员。」，**原值不渲染**；超过 64 字符或非字符串的值直接忽略；不带参数不显示提示。前端 `57e7aa6` + `80a2a27`、后端 `f825dc9` 均**自报完成，待 QA 复验**；`f825dc9` 的 `redirect=%2Fnext%2Fagents` 与 `80a2a27` 已对上（前端自报）。注：`/auth/oidc/login` 本身不接收回跳参数，从 SSO 登录不回原页见 K-18 / UI-097 |
| S-51 | 安全 / 文档 | P2 | 内网 IdP：先检查 `.env.example` 与 README；再把内网 IdP 的 host 加入出站白名单后走 SSO 登录 | `.env.example` 与 README 写明「IdP host 须加入出站白名单」；加白名单（`OUTBOUND_ALLOWLIST` 写 IdP 的 `host:port`）后 SSO 可正常登录；未加时同 S-50a / S-50b |
| S-52 | 安全 / 日志 | P1 | 触发任一入口的出站拦截（含 S-48d 的 302 跳转），查服务端日志 | 有一条 `event:"outbound.blocked"`，含 `host`、`port`、解析出的地址（`addresses`）、`reason`（`loopback` / `private` / `metadata` / `redirect` 等；302 跳转时 `reason=redirect` 并带 `targetReason`）；**不含 path 和 query**；响应体不回显 IP。实现见 AD `6656f9f`（`packages/core/src/outbound.ts:30-45`、`:176`） |
| S-53 | 安全 | P1 | webhook 依次指向私网地址、返回 4xx 的 mock、返回 5xx / 断网的 mock，各触发一次投递并读投递记录；再对失败投递做 replay | 新列 `webhook_deliveries.error_code`（可空，迁移 `005_webhook_error_code` 只加列）：被拦 → `failed` + **HTP-4003**、**不重试**；4xx → **HTP-4001**；5xx / 网络错 → **HTP-4002**；replay 时该列**清空**。实现见 AD `6656f9f`（`packages/runtime/src/webhook.ts:99-102`） |
| S-54 | 安全 / 回归 | P1 | 修复 G 上 3100 后（修复 AD 提供变量）：先不配 `OUTBOUND_ALLOWLIST`，让 Agent 调用 demo-http 工具（`http://127.0.0.1:8090/api`），并对 demo-mcp（`http://127.0.0.1:8090/mcp`）做 refresh 和一次 MCP 工具调用；再设 `OUTBOUND_ALLOWLIST=127.0.0.1:8090` 重试。开发 `.env` 由 Cursor Jackson 改，测试不动。3100 切换顺序（运维执行，目标提交 **`f825dc9`**；测完并经 Cursor Jackson 同意后再动，**每步需 Cursor Jackson 同意**）：备份 → `.env` 加 `OUTBOUND_ALLOWLIST=127.0.0.1:8090` → `pnpm db:migrate --confirm-db=forge` → 重启 → 验 demo-http / demo-mcp 不被拦；按 §16 范围冻结，放在测试之后 | 不配：demo-http 工具返回 `{ok:false, errorCode:"HTP-4003"}`；demo-mcp 的 refresh 返回 **400 HTP-4003**、MCP 工具调用返回 `{ok:false, errorCode:"HTP-4003"}`。配上 `127.0.0.1:8090`：demo-http 和 demo-mcp（refresh 与工具调用）都可用 |
| S-55 | 安全 | P1 | `OUTBOUND_ALLOWLIST=127.0.0.1:8090`；目标依次改为 `127.0.0.1:8091`、`localhost:8090`；IPv6 条目写成 `[addr]:port`（如 `[::1]:8090`）再分别访问 `[::1]:8090` 与 `[::1]:8091` | `127.0.0.1:8091`、`localhost:8090` **都拦**，HTP-4003（只认精确 `host:port`，不做名字归一）；IPv6 只认 `[addr]:port` 写法，白名单内的那个放行、其余拦 |
| S-56 | 安全 | P0 | 白名单内地址（`127.0.0.1:8090` 上的受控端点）返回 302，跳到其他内网地址（如 `127.0.0.1:8091`、`10.0.0.1`，以及元数据 `169.254.169.254`） | 跳转目标同样校验，**仍拦**（含跳到 `169.254.169.254`），HTP-4003，不跟随 |
| S-57 | 安全 | P0 | 白名单写一个域名的 `host:port`，该域名 DNS 解析到**不在白名单内**的内网 IP | **仍拦**，HTP-4003（按解析后 IP 校验，与 S-48 一致） |
| S-58 | 安全 | P1 | 白名单分别写成通配（`*.example:443`、`*`）、网段（`10.0.0.0/8`、`127.0.0.0/8:8090`）、只写 host 不写端口（`127.0.0.1`） | **格式非法 → 进程启动失败**（不是「不生效」）；启动校验细节见 OPS-028 |
| S-59 | 文档 | P2 | 检查 `.env.example` | 有 `OUTBOUND_ALLOWLIST` 及注释，注释里给出 `127.0.0.1:8090` 示例，**默认值为空** |
| S-60 | 安全 | P0 | CSRF 路径百分号编码绕过（安全专家复审，fastify 5.12.7 已复现）：OA 登录，带 `forge_session`、**不带** `X-CSRF-Token`，各发一次写请求（合法 body）：`POST /%61dmin/api/users`、`POST /a%64min/api/users`、`POST /admin/%61pi/users`、`PATCH /%61dmin/api/mcp/<已有 id>`；对照：未编码 `POST /admin/api/users` 无 CSRF | 编码路径与未编码路径**一致**：**403 POL-2001**「CSRF Token 缺失或无效」，不落库、不写成功审计（执行前后只读计数对比）。**预计 fail**：现状 `csrf.ts` 用 `request.url.startsWith("/admin/api")` 判断，编码路径能命中处理器但跳过 CSRF 校验。修复提交 AF（改用路由匹配后的路径或规范化解码后判断），是否本轮修由 Cursor Jackson 定。**附加回归**：同样的编码路径再打鉴权中间件（未登录访问 `/%61dmin/api/users` → 401，不能 200）和 `/admin` 下开放平台分流（编码路径不得落到错误分支） |
| S-61 | 安全 | P0 | 请求头 `env:VAR` 外带进程密钥（安全专家复审；本轮按方案 A，Agent专家 14:42 定：去掉展开、写入即拒；白名单方案记为下一轮功能）：收包端用**受控本地 mock `127.0.0.1:8090`**（不用公网）；只记 mock 收到的值「是否等于真实值」，**不打印、不落盘密钥**。子断言：**a** PA 在 MCP / Provider / 工具源的 headers 写入值 `env:FORGE_MASTER_KEY`（创建与修改各一次）→ **400 CFG-8504**，不落库、不写成功审计；**b** Provider `apiKey` 写 `env:FORGE_MASTER_KEY` → 400 CFG-8504（后端在解密后检查）；**c** builder、org_admin 同样写入 → 拒绝、不落库（无权限的先 403，有权限的 400 CFG-8504，记录实际值）；**d** 大小写与空白变体 `ENV:X`、` env:X` → 记录实际行为，若被接受，必须确认运行时**不展开**；**e** 普通字面量 header 指向 mock，触发 MCP refresh / Provider test / OpenAPI 工具调用 → mock 收到的头里不含任何进程环境变量值；**f** 接口返回、审计、服务日志里不出现解析后的值 | **预计 fail**（按 `f825dc9`）：现状 `envHeaders`（`packages/capabilities/src/index.ts:32`）与 `headersFor`（`packages/models/src/index.ts:80`）无条件展开 `process.env[name]`。修复提交 AG；CFG-8504 是否已被占用待后端确认。运维已只读确认 `forge`、`forge_test` 里没有 `env:` 引用（加密的 apiKey 列除外） |
| S-45 | 安全 | **P0** | 用户 X 已登录（保留旧 cookie）。PA 依次对 X 做三种操作（每种单独一轮）：**停用**、**降级**（如 OA→US）、**换部门**；X 用旧会话立刻发下一次请求（读 + 写各一） | 按修复 F 的预期：**停用、删除用户**，或用户**所在部门 / 上级部门被停用** → 下一次请求返回 **401**，同时**删掉该会话**；**降级 / 换部门** → 下一次请求即按新角色、新部门判定（原权限 403 / 原部门对象 404）。**已知缺陷**：基线会话是登录时快照（内存 Map，8h），现状仍按旧权限放行。与 **I-INT-10** 互相引用；S-28 为其子集；数据库故障见 S-45b、OPS-024、I-INT-10d |
| S-45b | 安全 | P0 | （挂 S-45）用户已登录；让会话校验查库失败（MySQL 断开，同 OPS-024），带 cookie 发请求；恢复后再用同一 cookie | 查库失败属基础设施故障：返回 **503**，**会话保留**；恢复后同一 cookie 继续可用。只有确认查到了用户且用户不可用时，才返回 401 并删会话 |
| S-46 | 安全 | P1 | web_fetch 出站：白名单为空；Agent 运行中让 `web_fetch` 工具依次请求回环 / 私网 / 链路本地 / 云元数据地址 | web_fetch 与 OpenAPI 工具均返回 `{ok:false, errorCode:"HTP-4003"}`；响应体不得出现解析出的 IP，与 S-39/S-40/S-42 同一出站校验。代码已有 `assertSafeUrl`，预期 pass（回归） |
| S-47 | 安全 | P0 | MCP call 出站：预置一条 MCP，其 url 指向受控监听端（可先临时把监听端加入白名单完成创建，再清空白名单）；Agent 运行时调用该 MCP 工具 | 调用前同样经出站校验：返回 `{ok:false, errorCode:"HTP-4003"}`，监听端无连接；响应体不得出现解析出的 IP。**已知缺陷**：`callMcpTool` 未调 `assertSafeUrl`，现状会真实连接。（已核对：S-39 只覆盖 discover（create / refresh），不含 call，故 S-47 单独保留） |
| S-48 | 安全 | P0 | DNS rebinding：用受控测试域名（首次解析到公网、连接时解析到 `127.0.0.1` / 私网；或直接解析到私网），分别打 MCP discover、MCP call、Provider test、web_fetch、webhook 五处。前置：受控 DNS 方案执行前由运维定，不改 3100 / 开发环境 | 出站校验在 **DNS 解析后按实际 IP 再校验一次**：五处均拦截，按 §15.2 各入口口径返回 HTP-4003；响应体不得出现解析出的 IP。现状待实测 |
| S-48a | 安全 | P0 | 绕过写法：云元数据 `http://169.254.169.254/latest/meta-data/`，分别打五处出站入口 | 被拦截，按 §15.2 各入口口径返回 HTP-4003，响应体不得出现解析出的 IP |
| S-48b | 安全 | P0 | 绕过写法：IPv6 回环 `http://[::1]:<port>/` 与 ULA 私网 `fd00::/8`（如 `http://[fd00::1]/`） | 被拦截，按 §15.2 各入口口径返回 HTP-4003，响应体不得出现解析出的 IP |
| S-48c | 安全 | P0 | 绕过写法：十进制 / 八进制 IP，如 `http://2130706433/`、`http://0177.0.0.1/`（均为 127.0.0.1） | 被拦截，按 §15.2 各入口口径返回 HTP-4003，响应体不得出现解析出的 IP |
| S-48d | 安全 | P0 | 绕过写法：公网可达的受控地址先 **302 跳转**到私网地址 | 跳转目标同样校验：被拦截，按 §15.2 各入口口径返回 HTP-4003，响应体不得出现解析出的 IP，不跟随到私网 |
| S-49 | 安全 | P0 | 白名单默认为空：不配置白名单，五处出站入口分别指向 mock `http://127.0.0.1:8090`；再把 8090 显式加入白名单重试 | 白名单为空时 8090 **同样被拦截**，按 §15.2 各入口口径返回 HTP-4003；响应体不得出现解析出的 IP；只有显式加入白名单后才放行。依赖 mock 8090 的用例须在前置里显式配白名单（见 `api-cases-addendum.md` PRE-MOCK） |
| F-SCH-10a | 功能 | P1 | 创建（POST）或更新（PATCH）schedule 时绑定 platform_admin 服务账号 | **400** SCD-4804（`requireUsableServiceAccount`） |
| F-SCH-10b | 功能 | P1 | 存量任务已绑 PA 服务账号（库内构造），调 `POST /schedules/:id/run` | **409** SCD-4804（`buildScheduleIdentity`） |
| F-SCH-11a | 功能 | P1 | 服务账号 disabled 后手动 `POST /schedules/:id/run` | 409 SCD-4801；schedule 状态**不变** |
| F-SCH-11b | 功能 | P1 | 服务账号 disabled 后 `POST /schedules/:id/enable` | 409 SCD-4801 |
| F-SCH-11c | 功能 | P1 | 服务账号 disabled 后等调度器自动触发 | 任务被暂停（只有调度器路径会暂停）。观察点：`GET /schedules/:id` 返回 `status:"disabled"`、`lastErrorCode:"SCD-4801"`、`failureCount` +1 |
| F-SCH-12 | 功能 | P1 | 并发手动 run 触发 skip | 409 SCD-4802 |
| F-SCH-13 | 日志 | P1 | OA 点手动 run | audit 含操作者用户 id + 执行用服务账号 id |
| F-SCH-14 | 功能 | P1 | （挂 S-45）服务账号**所属部门或上级部门被停用**：① 等调度器自动触发 ② 手动 `POST /schedules/:id/run` | ① 任务被自动暂停，记 **SCD-4801** ② **409 SCD-4801**，任务状态不变（后端本轮修） |
| F-SCH-15 | 功能 | P1 | （挂 S-45）**未绑定服务账号的老定时任务**：任务行里存的用户被停用、删除，或其所属部门被停用；① 调度器触发 ② 手动 run | 同 F-SCH-14：① 自动暂停，记 SCD-4801 ② 409 SCD-4801，状态不变（后端本轮修） |
| O-11 | 运维 | P1 | 检查 3100 监听地址 | 记录 0.0.0.0 vs 127.0.0.1；改 HOST 需 Cursor Jackson 批准（群里已有卡片） |

威胁映射表：`docs/qa/threat-model.md`。

## 11. 运维用例合入（OPS-001～OPS-029）

完整底稿：`docs/qa/ops-cases.md`。执行用临时端口 **3196** + 库 `forge_ops`，不碰 3100/3197/3198/3199。

与原 §5 O-* 对照：O-01～O-10 并入 OPS-001～023；**以 OPS 编号为准**。`ops-cases.md` 已换成运维新版（新增 OPS-024、OPS-025）。

| 重点 | 说明 |
|---|---|
| OPS-014 | 日志脱敏：步骤含 URL query 密钥 + 主动 log 的错误对象；有明文则定 P0。修复方向：共用 args-preview 判定 + pino `redact`（架构师意见） |
| OPS-012 | 会话存进程内存，重启后全部失效属**设计行为**：预期改为「重启后跳登录页，写操作不成功」（运维新版已改）；多实例部署会话不共享写进部署文档 |
| OPS-021 | 与群里 HOST 卡片联动；Cursor Jackson 未批准前只记录现状 |
| OPS-024 | **P0**，与 S-45 / S-45b 互引。MySQL 断开 30 秒后恢复：断开期间带会话的请求返回 **503**（不是 401），会话不能被删；恢复后同一 cookie 直接继续用，不用重新登录。**界面预期**：新控制台收到 503 时**不跳登录页**，页面显示错误提示和**重试按钮**，会话保留；数据库恢复后点重试即可继续 |
| OPS-025 | P2。autocannon 测修复 F 前后的 p95 延迟（只读接口如 `GET /admin/api/agents`，30s，c=20）；涨幅 >20% 记一般问题；EXPLAIN 检查用户 + 部门链查询走索引 |
| OPS-文档 | 出站白名单环境变量 **`OUTBOUND_ALLOWLIST`** 写进 `.env.example`，带注释和 `127.0.0.1:8090` 示例，**默认为空**（修复 AD，哈希待填；用例 S-59） |
| OPS-026 | **P0**。测试库守卫（修复 Z，架构师要求）：守卫放在 vitest 的 `globalSetup` 里，在任何测试文件连库之前执行；守卫必须在**应用建立数据库连接之前**就拦下，不能只拦 HTTP 请求——测试代码在进程内直接启动应用（如 `buildApp` / `inject`）、用种子 admin 登录连 forge 时也必须被拒绝；测试**只认 `TEST_DATABASE_URL`**，不从开发用的 `.env` 继承 `DATABASE_URL`；库名不以 `_test` 结尾 → **一律报错退出**，vitest **不留任何绕过方式**（没有放行用的环境变量或开关）。子用例：**OPS-026a** 没设 `TEST_DATABASE_URL` → 拒绝；**OPS-026b** 只设了 `DATABASE_URL=…/forge`、没设 `TEST_DATABASE_URL` → 拒绝；**OPS-026c** `TEST_DATABASE_URL=…/forge` → 拒绝；**OPS-026d** `TEST_DATABASE_URL=…/forge_test` → 通过；**OPS-026e** 在主工作区有 `.env` 的情况下直接跑 `pnpm test` → 拒绝；**OPS-026f** 种子脚本和迁移脚本（架构师口径）：库名以 `_test` 或 `_ux` 结尾直接放行；其他库名（包括 `forge`）必须传 `--confirm-db=<完全一致的库名>` 才写入。三条子断言：**f1** 不传参数 → 拒绝；**f2** 传 `--confirm-db=forge_x`（库名不匹配）→ 拒绝，只给通用的 yes 开关也拒绝；**f3** 传 `--confirm-db=forge` → 放行。**OPS-026g** vitest 只认以 `_test` 结尾的库，`TEST_DATABASE_URL=…/forge_ux` → 拒绝。**OPS-026h** 设了 `FORGE_ALLOW_NON_TEST_DB=1` 且 `TEST_DATABASE_URL=…/forge` → **仍然拒绝**（该变量不起任何放行作用）。**OPS-026j**（修复 Z，**只写用例，不执行，绝对不要跑 reset**）`pnpm db:reset` 不带 `--confirm-db` → 拒绝；带 `--yes` 或 `--force` → 也拒绝；只有 `--confirm-db=<完全一致的库名>` 才放行；migrate 和 seed 同样拒绝 `--yes` / `--force`。逐项（目标库为 `forge`）：`--yes`、`-y`、`--force`、裸 `--confirm-db`、`--confirm-db forge`（空格分隔）、`--confirm-db=forge_test`、`--confirm-db=Forge`、`--confirm-db=`（空）**均拒绝**；只有 `--confirm-db=forge` 通过。注意：`pnpm db:reset --confirm-db=forge` **仍被拒**（pnpm 只把参数传给最后一条命令），README 写成三步手动执行；后端测试 `d8906a7`。**OPS-026i** 测试代码在进程内启动应用（`buildApp` / `inject`）并指向 forge → 拒绝，且 forge 库里**没有任何新的 audit_logs 行或业务行**（执行前后只读计数对比）；**绕过 `vitest.config.ts`**（在 IDE 里直接跑单个测试文件、或换一份 vitest 配置）时，`db.ts` 仍拒绝非 `_test` 库、不建连接池（修复 AC `76bc68a`）。**已知缺陷 K-16**：现状未设置时落到默认库 `forge`（干净克隆复验时实际发生） |
| OPS-027 | **P0**。forge 库清理复核。前提：清理须经 Cursor Jackson 同意。**只用只读查询**。**前置检查（清理前，只读）**：查 `it-rs-…` 这个 platform_admin 用户自 12:42（UTC+8）起的登录审计（`auth.login`）；预期只有测试自己产生的记录，出现非测试来源的登录 → 判 **fail**，先当**安全事件上报**，再执行删除。**前置检查结果：pass**。证据（运维只读查询）：`it-rs-…` 没有任何 `auth.login` 记录，只有 12:42:56 和 12:42:57（UTC+8）两条 `run.create`；3100 的日志里也搜不到 `it-rs-`。**原待查项「种子 admin 每分钟 3 次登录来源不明」：已查清**，不再阻塞清理。证据（运维只读结论，时间均为 UTC+8）：最后一次登录是 12:50:52；12:44～12:50 之间的登录是后端测试在进程内启动应用、直连 forge 产生的，没有经过 3100；3100 的日志里当天只有 11:19 前端故意输错密码的 2 次登录；12:50:52 之后的 12 分钟内 forge 没有新的审计记录。清理后预期：① users、service_accounts、agents、api_apps、api_keys、llm_providers、tool_sources、mcp_servers、org_units 中 `it-` 前缀的行数为 0；② 没有状态为 active、且 base_url 指向私网地址、链路本地地址（如 169.254.169.254）、`file:` 或 127.0.0.1 的 Provider 和工具源；③ 没有孤儿行：按外键检查 runs、threads、messages、run_events、schedules、webhook_deliveries、llm_models、mcp_tools、approvals、run_steps、tool_calls、tools，每条外键引用都能对上（不查 sessions 和 user_roles：这两张表不存在，会话存在进程内存里，角色是 users 表上的字段）；④ `audit_logs` 行数**不少于清理前（306）**，一条都不能删（架构师裁定：判「不少于」而不是「一致」，重新登录会新增审计）；⑤ 清理前全库备份 `/tmp/forge-logs/forge-full-pre-cleanup-20261022-1319.sql`（权限 600，sha256 开头 `6ea2d637`），以及更早的两个备份：`/tmp/forge-logs/forge-pre-cleanup-20261022-1254.sql`（sha256 开头 `d7a39bb8`）和 `/tmp/forge-logs/forge-pre-cleanup-20261022-1254-extra.sql`（sha256 开头 `388d01f9`），清理前后核对哈希。**已知保留项**：`tool_sources` 的 demo-http（`http://127.0.0.1:8090/api`，active）是演示 mock，保留，不计入 ② 的 fail；`mcp_servers` 的 demo-mcp（`http://127.0.0.1:8090/mcp`，active）：**架构师确认保留，与 demo-http 同为 8090 演示 mock**。**清理规范**：清理一律**先列 id、再按 id 删**，不用 key 模式或时间窗做删除条件（本次 `service_accounts` 的偏差见 §16 复核结果第 2 项）。复核结果见 §16「OPS-027 复核结果」。备注（事故经过，按后端更正，时间均为 UTC+8）：① `it-ob-*` 的 Provider / 工具源 / MCP 来自修复 G 先写的失败测试，12:37:55～12:38:07；② 12:40:59～12:50:48 后端 7 次全量测试连了 forge（即每分钟的 admin 登录）；③ 12:49:48 的服务账号批次最接近 12:49:19～24 那次运行，约 24 秒的差距**未核实（未验）**；④ QA 在 12:41 与 12:43:20 的运行也有写入（含 12:42 的 2 个 users） |
| OPS-028 | **P1**（架构师已同意）。白名单格式非法启动失败（AD `6656f9f` + AE `f825dc9`）：用临时端口（如 3196）+ 临时 `.env` + `forge_test`，**不碰 3100**；`OUTBOUND_ALLOWLIST` 依次写成只有 host（`127.0.0.1`）、只有端口（`:8090`）、带通配（`*.example:443`）、网段（`10.0.0.0/8`）、端口 0（`127.0.0.1:0`）、非法格式（`a:b:c`）各启动一次；再用**混合样例** `127.0.0.1:8090,10.0.0.0/8,127.0.0.1:9000,*.example:443` 启动一次。**预期**：每次：进程**退出码非 0**；`curl 127.0.0.1:<临时端口>/readyz` **连不上**（端口未起）；日志**逐条**指出第几项、该项值、原因，**不回显其他项、不打印整行**。文案原文（AE）：`OUTBOUND_ALLOWLIST 第 N 项 "<值>" 不合法：<原因>`，原因取：「不支持 CIDR 网段，只能写精确的 host:port」「不支持通配符，只能写精确的 host:port」「缺少端口，不支持只写 host」「缺少主机」「端口必须是 1-65535 的整数」「格式应为 host:port（IPv6 写成 [addr]:port）」。混合样例应恰好两行：`OUTBOUND_ALLOWLIST 第 2 项 "10.0.0.0/8" 不合法：不支持 CIDR 网段，只能写精确的 host:port` 和 `OUTBOUND_ALLOWLIST 第 4 项 "*.example:443" 不合法：不支持通配符，只能写精确的 host:port`；合法项 `127.0.0.1:8090`、`127.0.0.1:9000` **不出现在日志里**。对照：只写合法项 `127.0.0.1:8090` 能正常启动（来源 `packages/core/src/allowlist-format.ts`） |
| OPS-029 | **P1**。迁移 `005_webhook_error_code` 非破坏性（AD）：在 `forge_test` 上，迁移前只读统计 `webhook_deliveries` 及其他表行数，执行 `pnpm db:migrate --confirm-db=forge_test`，再统计一次；重复执行一次。**预期**：只新增 `webhook_deliveries.error_code`（`VARCHAR(16) NULL`），**不改不删已有数据**：各表行数前后一致，已有行 `error_code` 为 NULL；`schema_migrations` 多一行 `005_webhook_error_code`；重复执行输出「already applied」且无变化。**不得在 forge 上执行**（forge 的迁移按 §16 放在测试之后由 Cursor Jackson 决定） |

## 12. 架构师横向补洞（合并进 UI / F）

> 前端审阅（`/tmp/forge-logs/fe-cases-review.md`）新增的 UI-083～092 编号接在 UI-080～082 之后，明细在 `fe-cases.md`。UI-092（会话过期时弹窗确认）与 UI-082（多标签退出）互补。

| ID | 来源 | P | 步骤 | 预期 |
|---|---|---|---|---|
| UI-042a | 扩 UI-042 | P0 | 分别用 PA / OA / 部门成员(BL或OP) / AU(只读) 登录，走侧栏各页与关键按钮 | 与角色×接口矩阵一致：无权限入口隐藏或禁用；直打 API 403 有中文提示 |
| UI-042b | 地址栏越权 | P0 | OA 或部门成员：URL 换成他部 Agent id / 审批 id（新控制台若无详情则旧控制台/`/admin/api`+UI） | 与「不存在」相同的 404 空态，**不露出名称** |
| UI-080 | 状态：重复发布 | P1 | 已发布 Agent 再点发布（或两标签同时确认发布） | 一方成功；另一方可理解冲突/已发布，不双份脏数据 |
| UI-081a | 状态：过期瞬间批准 | P1 | 审批已被清理为 expired；B 标签点批准 | 409 CFG-8503，提示已过期/不可处理，**不能**成功批准 |
| UI-081b | 状态：过期未清理 | P1 | 已过 `expires_at` 但未清理；B 标签点批准 | 预期同 a（409、不能批准）。**已知缺陷** I-APR-36：现状 200 批准成功，执行如实记 fail |
| UI-082 | 会话：多标签退出 | P0 | A 退出登录后，B 标签立刻点批准/发布等写操作 | 跳转登录；写请求失败（401），服务端无成功副作用 |

## 14. 后端接口审阅合入（审 `b7bfce9`，`/tmp/forge-logs/api-cases-review.md`）

口径（架构师）：预期写**正确行为**，代码不符标「已知缺陷」，执行如实记 fail；不写「两种结果都算通过」。

### 14.1 B1 错预期修正（9 条）

| 审阅编号 | 用例 | 修正后 |
|---|---|---|
| W-01a | I-G-06 | 413；现状 500 SYS-9001，已知缺陷 |
| W-01b | F-SCH-10 | 拆 F-SCH-10a（创建/更新绑 PA SA → 400）/ 10b（存量绑 PA 手动 run → 409） |
| W-02 | F-SCH-11 | 拆 11a 手动 run 409 状态不变 / 11b enable 409 / 11c 调度器触发才暂停 |
| W-03 | I-RBAC-02 | 改测 cancel / decide；decide 跨部门预期与不存在完全相同（「审批不存在」），现状「Run 不存在」→ 已知缺陷 |
| W-04 | I-SCOPE-10 | 统一「本部门 + 子部门」：10a Run 200 pass；10b schedule 预期 200（现状 404 缺陷）；10c R-sa 预期 200（现状 404 缺陷） |
| W-05 | I-RBAC-01 | 前置带本会话 CSRF；判定「不出现『角色缺少权限: <key>』的 403」 |
| W-06 | UI-034 / UI-081 | 拆 a（已清理 → 409 CFG-8503）/ b（过期未清理 → 预期 409，现状 200 缺陷，I-APR-36） |
| W-07 | I-G-04 | 403 POL-2001「CSRF Token 缺失或无效」；无会话 401；指向 I-CSRF-01～05 |
| W-08 | I-DOC-03 | 例外补全：open runs 202、integration runs 202、invoke 结束 200 / 未结束 202 |

### 14.2 B2 已知缺陷标注（K-01～K-08）

| 编号 | 用例 | 预期 | 现状 |
|---|---|---|---|
| K-01 | I-G-07 | 400 | 500 SYS-9001 |
| K-02 | I-OPEN-02 | 文案统一 | 4 种文案（待安全定级） |
| K-03 | I-G-08 | 写操作皆审计 | 6 个接口不写（含 logout）；user.update 不记 status |
| K-04 | S-28（扩展 S-45） | 401 | 200，会话快照 8h |
| K-05 | I-SCOPE-01～04、I-SCOPE-06、S-22、S-38 | users / audit / dashboard 按本部门 + 子部门（PA 全局）；apps 全局可读、改根部门 app/key 403 【待 Cursor Jackson 拍板】 | 全局 200（users 修复 A 已改） |
| K-06 | S-35 / I-INT-11 | 403 | 202 |
| K-07 | S-04 | 限流 / 锁定 | 无 |
| K-08 | S-25 | 400 | runs/audit 非法 limit → 500 |
| K-09 | I-CSRF-06（及 I-G-06 / I-G-07） | 坏 JSON 400、超 2MB 413、Content-Type 不对 415、空 JSON 体 400 | 均 500 SYS-9001（body 先于 CSRF 解析，顺序保留） |
| K-10 | I-MDL-11（执行表 #21～#25） | Provider / 模型只有 PA 能写，OA / BL → 403 | OA、BL 持有 `model.manage`，可写（越权，P1；架构师推荐 C 方案，【待 Cursor Jackson 拍板】；修复 **Q**） |
| K-12 | I-SKL-07（执行表 #33） | `status` 非法 → 400 CFG-8501，不入库 | `status:"foo"` 200 入库，Skill 静默下线；超 16 字符 500（修复 T） |
| K-13 | I-APR-38（执行表 #42），P1 | Run 已结束 → decide 409 RUN-7005「Run 已结束，审批不可操作」，审批 `expired`，Run 不恢复 | decide 200，Run 继续执行（修复 W） |
| K-14 | S-30（执行表 #10）、UI-096，P1 | 开放重定向：非本站 origin 一律回落 `/next/`；新控制台登录页跳回参数统一为 `redirect`（架构师裁定） | `//evil.example` 被放过，跳外域（修复 R） |
| K-15 | UI-056，P2 | 字号只用 12/13/14/16/20/28 | 登录页标题「登录 Forge 控制台」18px、Agents 页 H1 24px；不在 `04ef9a8` 改动范围；前端确认 P2，等测试问题汇总后一起改，不动本次冻结基线 |
| K-16 | OPS-026，**P0** | 测试只认 `TEST_DATABASE_URL`，库名非 `_test` 结尾或未设置 → 拒绝运行（vitest `globalSetup` 守卫） | 未设 `DATABASE_URL` 时 `pnpm test` 落到默认库 `forge`（干净克隆复验时实际发生）；修复 Z |
| K-17 | 执行表 #12 #13 #15 #37 #38 #39 #85，P2 | 缺权限 → 403 的路径有自动化覆盖 | 这 7 条缺权限 403 的路径没有任何自动化覆盖（无单测；所有内置角色都有 agent.view / run.view，无法用内置角色触发；#85 走 Connector JWT）；待 API 实测覆盖 |
| K-18 | UI-097、S-30，**P2** | 从 SSO 登录后回到原页面；参数名已定 `redirect` | `/auth/oidc/login` 入口不接收回跳参数，登录页 SSO 链接也不带 `redirect`，从 SSO 登录一律落 `/next/`；下一轮后端入口与前端链接一起改（范围冻结后不进本轮）。本轮预期：落 `/next/` |
| K-11 | UI-095 | 确认框内操作收到 401 / 403 时确认框自动关闭，只留错误提示 | 发布收到 403 后确认框不关闭 |

### 14.3 新增

- **`docs/qa/api-cases-addendum.md`**：I-PUB / I-AUTH / I-AGT / I-MDL / I-MCP / I-SKL / I-TS / I-RUN / I-APR-30～36 / I-SCH / I-APP / I-USR / I-PLG / I-SA / I-OPEN-10～21 / **I-INT-01～13（I-INT-10 P0：停用、删除用户、部门停用均 403 CON-4706）** / I-CSRF-01～05 / I-AUD-01～11 / I-ERR-01～22 / I-DOC-10～45 / I-RBAC-10～11。connector 前置：3197 开开关 + 测试 RSA，私钥仅 `/tmp`，测完删。
- **`docs/qa/route-exec-matrix.md`**：86 行执行矩阵（§2.7 / §8.5 指向）。
- **S-45**（§10）：停用 / 降级 / 换部门后旧会话下一次请求即生效；与 I-INT-10 互引。
- 后端顺带缺陷候选已用例化：PATCH user 不传 dataScope 被重置（I-USR-07）、PATCH schedule 非法 cron 不带 status 入库（I-SCH-09）、`apps/:id/keys` / `plugins/:id/uninstall` 不存在 id 返回 200（I-APP-06 / I-PLG-03）。

## 15. 安全批次与架构师口径合入（本轮）

### 15.1 安全专家批次（来源：安全专家只读评审 `b7bfce9` 的「(b) 应补充的安全测试用例」）

- 新增 **S-38～S-44**（§10）：S-38 审计日志跨部门隔离、S-39 MCP discover SSRF、S-40 Provider test SSRF、S-41 审计 details 明文敏感值、S-42 webhook 出站、S-43 args_preview 已知限制向量、S-44 生产默认密钥与 SSO 拒启。
- **S-10** 改为逐项列出安全响应头（CSP / X-Content-Type-Options / X-Frame-Options·frame-ancestors / Referrer-Policy），每缺一项单独记缺陷。
- 会话快照（停用 / 降级 / 换部门）改编号为 **S-45**（原编号与安全专家「审计日志跨部门隔离」撞号），定 **P0**。

### 15.2 出站校验口径（架构师已定）

MCP discover / call、Provider test、web_fetch、webhook **统一走同一个出站校验**：拦截回环、私网、链路本地、云元数据地址；DNS 解析后再校验一次（防 rebinding）；8090 mock 只能通过显式白名单放行，白名单默认为空。白名单变量 **`OUTBOUND_ALLOWLIST`**：只认精确 `host:port`，逗号分隔，默认空 = 全拦；不支持通配、网段、只写 host（修复 **AD**，哈希待填；用例 S-54～S-59）。错误码统一为 **400 HTP-4003「目标地址不允许（内网/回环/元数据）」**（新增错误码，**架构师已确认，定稿**），**不回显解析出的 IP**。断言口径按入口分开：**配置阶段 400**；**只有 OIDC 是 502**——管理端 JSON 接口 502 HTP-4003（S-50a），浏览器整页跳转的登录入口 / 回调 302 到 `/next/sign-in?ssoError=HTP-4003`（S-50b）；其余入口按后端口径；**运行阶段** `{ok:false, errorCode:"HTP-4003"}`；**Run 最终以 HTP-4003 结束**。每个入口都加一条断言：**响应体中不得出现解析出的 IP**。

| 入口 | 预期（白名单为空，目标为回环 / 私网 / 链路本地 / 元数据） | 用例 |
|---|---|---|
| MCP 创建 / 修改 / refresh | **400 HTP-4003**；创建时的工具发现只是 warning，写 `last_error`，不影响 400 判定 | S-39、I-MCP-02 |
| MCP 工具调用 | `{ok:false, errorCode:"HTP-4003"}` | S-47 |
| Provider 创建 / 修改 / test | **400 HTP-4003**（test 不再返回 `{ok:false}`）；运行中被拦**不重试、换下一个候选**，全部候选失败时 Run 以 HTP-4003 结束 | S-40 |
| web_fetch、OpenAPI 工具 | `{ok:false, errorCode:"HTP-4003"}` | S-46 |
| webhook | 配置 webhookUrl → **400 HTP-4003**；投递记 `failed`、不重试；replay → **200**，投递状态 `failed` | S-42、S-53 |
| OIDC（管理端 JSON 接口） | **无此接口**（架构师已确认）：只有 `GET /admin/api/sso` 查状态；502 HTP-4003 由身份层单测覆盖 | S-50a |
| OIDC 登录入口 / 回调（浏览器整页跳转） | **302** 到 `/next/sign-in?ssoError=HTP-4003`（不再返回 502 JSON；跳回参数为 `redirect`，AE `f825dc9`），登录页显示「单点登录暂不可用：身份提供方的地址被出站策略拦截，请联系管理员。」；合法跳回地址放 `redirect` 参数 | S-50b、S-51 |
| 白名单 `OUTBOUND_ALLOWLIST` | 精确 `host:port`；白名单内地址 302 到其他内网仍拦；DNS 到非白名单内网 IP 仍拦 | S-54～S-59 |
| 全部入口 | 响应体中不得出现解析出的 IP；服务端日志记 host / 解析 IP / 原因 | S-52 |
| DNS rebinding（五处） | S-48 |
| 白名单为空时 8090 也被拦 | S-49 |

### 15.3 全局可见口径（架构师建议，【待 Cursor Jackson 拍板】）

- apps / skills / mcp / providers **全局可读属于设计**（I-SCOPE-05、S-22 读部分）；org_admin 改根部门 app 或 key 算越权 → **403**（I-SCOPE-04、I-SCOPE-06、S-22 写部分）。
- users / audit / dashboard 按**本部门 + 所有子部门**过滤，只有 PA 看全局；现状全局可见，按缺陷记（I-SCOPE-01～03、S-38；users 已在修复 A 中修掉，待复验）。

### 15.4 已知限制与定级（架构师）

| 项 | 口径 | 影响用例 |
|---|---|---|
| 审批不存在也返回 `RUN-7001` | 本轮不新开错误码；decide 跨部门与审批不存在完全相同即 pass | I-RBAC-02、I-APR-35 |
| 工具返回结果 `result_json` / 工具消息未打码 | **P1 已知限制**，本轮不打码；执行 S-31 / UI-032 时 result 部分不记 fail，报告列为已知限制 | S-31、UI-032 |
| 定时任务 GET 返回 `input_json` 明文 | **P2**，下一轮做；本轮不记 fail | F-SCH-01、I-AUD-06（审计侧仍按打码判定） |
| 打码规则 | `max_tokens`、`input_tokens`、`output_tokens` 保留原值；单独的 `token` / `tokens` 打码 | I-APR-12 |
| 会话快照 | **S-45 定 P0** | S-45、S-28、K-04 |
| 建用户 / 服务账号不能指定部门 | **P2 功能缺陷**（不算安全问题），本轮不修。以后的规则：请求可选填 `orgUnitId`；PA 可填任意部门，org_admin 只能填本部门或子部门，超出范围 403 POL-2001；不填即调用者自己的部门；PATCH 改部门规则相同。本轮需要跨部门数据的用例（I-SCOPE-10c、I-SA-10）由运维在 3196 的 `forge_ops` 改库造 | I-SCOPE-10c、I-SA-10 |
| MCP / Skill / 工具源写权限不分部门 | **设计缺口 P2**，本轮执行**不按 fail 计**。目标设计（C 方案）：资源带归属部门字段；OA / BL 可新建、可改本部门及子部门的资源；无归属部门的全局资源只有 PA 能改。需改表，下一轮做。【待 Cursor Jackson 拍板】，架构师推荐 C 方案 | 执行表 #27～#29、#31、#33、#34、#36 |
| 插件卸载不按部门判定 | 本轮修复 P 只做「卸载不存在的插件 → 404」和「org_admin 卸载 → 403」测试；按插件 owner 部门判定放到**下一轮**，与 MCP、Skill 归属部门迁移一起做（plugins 表目前只有 `created_by`） | I-PLG-04、执行表 #68 |
| 没有写权限时隐藏编辑和删除按钮 | 本轮**不测**；等 Cursor Jackson 拍板方案 C 之后由前端实现，到时再补用例（权限不足时的 403 提示见 UI-093） | 待补 |

### 15.5 横向补充（架构师）

| 项 | 处理 |
|---|---|
| a. 已拒绝的审批再 decide 批准 → 409，状态不变 | 原无等价用例（I-APR-21 只覆盖 approved 后再决定），新增 **I-APR-37** |
| b. waiting_approval 的 Run 被取消后，审批不可操作，decide → 409 | 原无等价用例，新增 **I-APR-38** |
| c. 服务账号改成 platform_admin 后，已有定时任务被调度器自动暂停，记 SCD-4804 | 并入 **F-SM-04** |
| d. A 标签页退出后 B 标签页写操作 → 跳登录、请求不成功 | 已有 **UI-082**，内容完整（跳转登录、写请求 401、无成功副作用），不改 |
| I-SCOPE-10c / I-SA-10 正反两面 | 正：父部门 OA 绑定子部门 SA → 200；反：绑定兄弟 / 上级部门 SA → 404 与不存在相同、不露账号名 |

### 15.6 UX 批次

Agent专家所列 UX 批次（UI-053～UI-057 改 4 条；新增 UI-059、UI-065～UI-069、UI-072～UI-074）**已在 `7823da5` 合入**（原文 `~/forge-baseline/ux-cases.md`），明细见 `fe-cases.md` 与 §9。

## 16. 后端修复串复验清单

- 分支 `fix/blockers-authz-mask`（worktree `/Users/libo/projects/forge-blockers`，仅本地，未推送），基于 `4c2555e`。
- 提交依次（按后端给的顺序）：**A** `dfef71f` · **B** `22b5254` · **C** `020c1e0` · **D** `eed019d` · **E** `e97cbba` · **F** `cf41287` · **G** `40bf11c` 出站私网拦截（错误码**待后端给**）· **H** `42299c5` 审批统一 404 RUN-7001 + 已知打码限制（文档）· **I** `1422152` 查库失败返回 503 SYS-9003（原记 `fda5a74`：只是 amend 了提交说明（加 I-INT-10d），QA 只读核对两者代码树相同，均为 `33af686`；`fda5a74` 不在分支上但对象仍可达）· **J** `5dca21b` 定时任务每次触发重新校验身份 · **L** `b8245ee` agent 停用 409 + status 只收两值（续篇 `b038bd2`：integration 按映射用户部门子树判定 Agent，I-INT-17）· **M** `554ce7c` 取消已结束 Run 返回 409 RUN-7005 · **N** `84cb837` cron 先解析再建 Run · **O** `d71af88` body 解析返回 413 / 400 / 415 · **P** `43a57b1` 卸载不存在的插件返回 404 + org_admin 卸载 403 测试（后端建议本轮只做卸载不存在的插件返回 404、按部门判定放到下一轮，架构师已同意）· **R** `0dfa398` 开放重定向 · **T** `a53128c` 用户 / Skill status 白名单 · **V** `6c89a79` 用户列表 presenter，`idp_subject` / `is_emergency_admin` 只给 PA · **W** `6e3c093` I-APR-38：`decideApproval` 判关联 Run 已结束 → 409 RUN-7005 并置审批为 `expired` · **X** `7521dc5` 无主 Agent 只允许 PA 写 · **Y** `c5009e9` 补 6 个审计 action（`auth.logout`、`schedule.enable`、`schedule.disable`、`open.run.cancel`、`integration.run.create`、`integration.run.cancel`）· **Z** `a5cbb35` 测试库名守卫（OPS-026）· **AB** `2244dbb` `orgSubtreeIds` 改为 `path = ? OR path LIKE ? ESCAPE '!'`（转义 `!` `%` `_`，末尾拼 `/`），同时修 `getActiveUserById` / `getActiveServiceAccountById` 里 `LEFT(...)=` 把 `/x/b` 停用误判到 `/x/bc` 的问题（I-SCOPE-13～15）· **AC** `76bc68a` `db.ts` 在 vitest 进程中库名不以 `_test` 结尾直接报错、不建连接池（OPS-026i）· `d8906a7` OPS-026j 仅补测试（db:reset 守卫端到端）· **AD** `6656f9f` 出站白名单 `OUTBOUND_ALLOWLIST`（精确 `host:port`，格式非法启动失败）+ OIDC 被拦整页跳转 302 `ssoError` + `outbound.blocked` 日志 + `webhook_deliveries.error_code`（迁移 `005_webhook_error_code`）（S-50b、S-52～S-59、OPS-028、OPS-029）· **AE** `f825dc9`（父 `6656f9f`）OIDC 被拦 302 到 `/next/sign-in` 时改带 `redirect`：合法路径 URL 编码后带上，不合法或默认 `/next/` 不带，不再输出 `returnTo`；白名单报错只点名非法项（S-50b、OPS-028）。前端（`fe/sso-error`，仅本地）：`57e7aa6`（父 `04ef9a8`）S-50b 登录页提示；`80a2a27`（父 `57e7aa6`）S-30 登录后跳回二次校验（新增 `apps/console/src/lib/safe-redirect.ts`，改 `user-auth-form.tsx`）（UI-096）。另：**Q** K-10 收回 org_admin、builder 的 `model.manage`（**待拍板方案 C**；单独提交，不并入 P）。
- **QA 只读核对（13:11 UTC+8，`git -C /Users/libo/projects/forge-blockers`，未跑测试、未连库）**：分支 `fix/blockers-authz-mask` HEAD = `c5009e9`；`cf41287..c5009e9` 共 17 个提交，G～Z 的 16 个哈希加 L 续篇 `b038bd2` 全部在分支上（`merge-base --is-ancestor` 逐个确认）；A～F 也在分支上；`fda5a74` 对象存在但**不在**分支上。分支上的实际顺序是 I → J → G → H → L → M → N → O → P → R → Z → T → V → W → X → L 续篇 → Y，和字母顺序不同。
- **QA 只读核对（13:20 UTC+8）**：分支 HEAD = `d8906a7`；`c5009e9..d8906a7` 依次为 `2244dbb`(AB) → `76bc68a`(AC) → `d8906a7`(OPS-026j 测试)，三个都在分支上、顺序正确；`git rev-parse <hash>^{tree}`：`fda5a74` 与 `1422152` 均为 `33af686`。
- **QA 只读核对（13:33 UTC+8）**：`fix/blockers-authz-mask` HEAD = `6656f9f`，父提交 `d8906a7`，`d8906a7..6656f9f` 只有 AD 一个提交。`git grep 'HTP-400'`：全仓只有 HTP-4001 / 4002 / 4003 三个码，HTP-4003 只用于出站拦截（`packages/core/src/outbound.ts:21` `OUTBOUND_BLOCKED_CODE`），**无重复**。
- **后端自报，待 QA 复验**（13:29 UTC+8，连 `forge_test`）：typecheck 0 错；42 个文件，680 条通过、2 条跳过（仍是 dist 未构建的 `tests/routes.test.ts:115`、`:120`）；`smoke:isolated` 通过；路由 86 条。
- **执行前提（AD）**：`forge_test` 须先迁移到 `005_webhook_error_code`（`pnpm db:migrate --confirm-db=forge_test`，按 OPS-026j 规则）。
- **开测前提（架构师 + 运维，13:51 UTC+8 更新，替代「只连 `forge_test`」）**：全程**不碰 `forge`、3100、3198 / `forge_ux`**（3198 是 Cursor Jackson 的基线；只有他审批时明确同意才可切换）。测试环境：**3195 / `forge_fe`**（新建，前端用例连它，配 4178 预览）、3197 / `forge_connector`、3196 / `forge_ops`，以及 vitest 用的 `forge_test`。开测前这四个库都迁移到 `005_webhook_error_code`（`forge_fe`、`forge_connector`、`forge_ops` 带 `--confirm-db=<库名>`）；3195、3196、3197 实例切到冻结点（后端 `f825dc9`、前端 `80a2a27`），只监听 127.0.0.1，`OUTBOUND_ALLOWLIST` 加 `127.0.0.1:8090`（mock）。以上由运维在获批后执行、结果贴日志；都是一次性测试库，测完连同实例全部删除，不需要 Cursor Jackson 另外同意。**K-10、I-MDL-11 本轮按「预计 fail，等方案 C 决定」执行**；方案 C 获批后修复 Q 放到下一轮，不改本轮冻结范围。**S-60、S-61 为新发现 P0（预计 fail）**：是否本轮修、冻结点是否随之变化，由 Cursor Jackson 定；S-61 预期待架构师定 `env:` 语义。开测暂停到安全复审补齐并获批。
- **QA 只读核对（13:36 UTC+8）**：`fix/blockers-authz-mask` HEAD = `f825dc9`，父 `6656f9f`，AE 在分支上；`f825dc9` 的 `apps/api/src/routes/auth.ts:34` 为 `params.set("redirect", safe)`（`safe` 等于 `/next/` 时不设），文件中不再给 302 设 `returnTo`；`/auth/oidc/login` 自身入参仍为 `returnTo`（`:80`）。前端 worktree `/Users/libo/projects/forge-fe-sso` 分支 `fe/sso-error` HEAD = `80a2a27` → `57e7aa6` → `04ef9a8`，`80a2a27` 只改 `safe-redirect.ts`（新增 25 行）与 `user-auth-form.tsx`；无远端分支包含它（仅本地）。
- **后端自报，待 QA 复验**（13:34 UTC+8，连 `forge_test`）：typecheck 0 错；42 个文件，689 条通过、2 条跳过（dist 那两条）；`smoke:isolated` 通过；路由 86 条。
- **前端自报，待 QA 复验**：`80a2a27` 在 4178 预览连 3198 自测通过；`f825dc9` 的 `redirect=%2Fnext%2Fagents` 与 `80a2a27` 已对上。
- **范围冻结**：后端冻结在 **`f825dc9`**（AE），前端冻结在 **`80a2a27`**；之后新问题只记用例 / 已知缺陷，**P0 除外**；3100 切到 `f825dc9` 与迁移放在测试之后，经 **Cursor Jackson** 同意再动。
- **（13:18）后端自报，待 QA 复验**（13:18 UTC+8 那次运行，全部连 `forge_test`）：typecheck 通过；40 个文件，629 条通过、2 条跳过；`smoke:isolated` 通过；路由 86 条。跳过的两条是 `tests/routes.test.ts:115`、`:120`（`/next/` 页面与 SPA 回落，因 `apps/console/dist` 未构建）。**执行前置项**：执行时先构建 dist，再复跑这两条。修复 T 的非法 status 测试位置：`tests/status-whitelist.test.ts:54`。
- **（上一次）后端自报，待 QA 复验**：13:08–13:09（UTC+8）连 `forge_test`；typecheck 通过；37 个文件，597 条通过、2 条跳过（跳过原因待后端说明）；`smoke:isolated` 通过；路由 86 条。
- 复验时机：本轮执行测实问题后，按下表排队复验；复验结论记到对应用例 ID。
- **冻结基线的前置条件**：修复 **Z**、**OPS-026**（测试库守卫）、**OPS-027**（forge 库清理复核）必须先完成并通过；**K-16 已由架构师定为 P0**。

| 复验用例 | 说明 |
|---|---|
| S-20、S-21 | org_admin 提权 / 跨部门改用户（A） |
| S-31、UI-032 | 运行详情、审计详情打码（B）；`result_json` 本轮不打码（§15.4） |
| I-APR-12 | 打码保留 `max_tokens` / `input_tokens` / `output_tokens` |
| I-INT-10a～c | connector 主体停用 / 删除 / 部门停用 → 403 CON-4706（C） |
| I-SCOPE-10a～c | 本部门 + 子部门范围；SA 绑定正反两面（D） |
| I-SCOPE-13、I-SCOPE-14、I-SCOPE-15 | 部门子树前缀匹配：`_` / `%` / `\` 不当通配、路径互为前缀不得串到兄弟部门；`/x/b` 停用不得误判 `/x/bc`（AB `2244dbb`） |
| OPS-026i | 进程内 / 绕过 `vitest.config.ts` 时 `db.ts` 拒绝非 `_test` 库、不建池（AC `76bc68a`） |
| OPS-026j | `db:reset` / migrate / seed 的 `--confirm-db` 守卫，只写用例不执行（测试 `d8906a7`） |
| I-RBAC-02 | decide 跨部门与审批不存在相同（D） |
| S-45 | 会话快照：每次请求按用户 id 重读状态 / 角色 / 部门（F） |
| OPS-025 | 修复 F 前后 p95 与索引 |
| S-39、S-40、S-42、S-46～S-49（含 S-48a～d）、S-50a、S-50b、S-51～S-59、I-MCP-02 | 出站私网拦截（G）：统一 **HTP-4003**（架构师已确认，定稿）；S-52 / S-53 由 AD `6656f9f` 实现；S-50a **无此接口**；S-50b 由 AE `f825dc9` + 前端 `57e7aa6` / `80a2a27` 实现（自报，待 QA 复验）；S-54～S-59、OPS-028、OPS-029 依赖 AD |
| S-50b、UI-096、UI-097 | OIDC 被拦 302 带 `redirect`（AE `f825dc9`）；登录页提示与跳回二次校验（前端 `57e7aa6`、`80a2a27`）；SSO 入口不回原页为 K-18（下一轮） |
| OPS-028、OPS-029 | 白名单格式非法启动失败；迁移 005 只加列（AD `6656f9f`） |
| （H） | 待后端说明 |
| S-30（执行表 #10） | 开放重定向回落 `/next/`（R，K-14） |
| I-USR-01（执行表 #57）、执行表 #59、I-USR-12（执行表 #58） | 用户 status 白名单（T，建用户 `disabled` 生效、`foo` → 400 CFG-8501）；用户列表 presenter，敏感字段只给 PA（V） |
| I-APR-38（执行表 #42） | Run 已结束 → decide 409 RUN-7005「Run 已结束，审批不可操作」，审批 `expired`（W，K-13）；I-APR-37 为 409 CFG-8503 |
| I-AGT-13（执行表 #16～#18） | 无主 Agent 只允许 PA 写（X） |
| I-INT-17（执行表 #83） | integration 建 Run 复用 `agentAccessible`（L，续篇 `b038bd2`）；不检查 `api_enabled` 是架构师定的边界，不算缺陷 |
| I-AUD-01 / 执行表 #9 #47 #48 #79 #83 #86 | 补 6 个审计 action（Y） |
| OPS-026a～j | 测试库名守卫（j：`db:reset` / migrate / seed 拒绝 `--yes` / `--force`，只认 `--confirm-db=<库名>`；不执行 reset）：vitest `globalSetup`（在应用建立数据库连接前拦截，进程内 `buildApp` / `inject` 指向 forge 也拒绝且不落任何行）、只认 `TEST_DATABASE_URL` 且只认 `_test` 结尾（`_ux` 也拒绝，`FORGE_ALLOW_NON_TEST_DB=1` 也不放行）、种子 / 迁移非 `_test` / `_ux` 库须 `--confirm-db=<库名>`（Z，K-16，P0） |
| OPS-027 | forge 库清理复核（只读）：运维已清理，QA 13:25～13:27（UTC+8）只读复核，结果见下方「OPS-027 复核结果」 |
| I-SKL-07（执行表 #33） | Skill status 为 "foo" 或超 16 字符 → 400 CFG-8501，断言码和文案（K-12，修复 T；后端测试 `tests/status-whitelist.test.ts:54`） |
| I-MDL-11（执行表 #21～#25） | 收回 org_admin、builder 的 `model.manage`，Provider / 模型只有 PA 能写（K-10，P1，修复 **Q**：待 Cursor Jackson 拍板方案 C；单独提交，不并入 P） |
| I-PLG-04、I-PLG-03、执行表 #68 | 本轮 P 只做：卸载不存在的插件 → 404 不写审计；补「org_admin 卸载 → 403」测试（**待后端提交**）。单测四种：① 非 PA 有卸载权限的身份卸载外部门插件 → 404（**下一轮**）② 卸载本部门插件成功（**下一轮**）③ PA 卸载任意部门插件成功 ④ org_admin 卸载 → 403 |
| S-45b、I-INT-10d（原 I-INT-10b）、OPS-024 | 查库失败返回 503，会话保留（I） |
| F-SCH-14、F-SCH-15、F-SM-04a、F-SM-04b | 定时任务重新校验身份：SA 部门停用；未绑 SA 的老任务存的用户不可用（J） |
| I-AGT-05、I-AGT-11、I-AGT-11b、I-AGT-11c | agent 停用 409 CFG-8503；status 只接受 active / disabled（L） |
| I-RUN-06、I-OPEN-23（执行表 #79）、I-INT-16 | 取消已结束 Run 返回 409 RUN-7005「Run 已结束，不能取消」（M） |
| I-SCH-17、I-ERR-20 | cron 先解析再建 Run（N） |
| I-G-06、I-G-07、I-CSRF-06 | 413 / 400 / 415（O） |

**OPS-027 复核结果**（QA 只读，2026-10-22 13:25～13:27 UTC+8；连接沿用 `/tmp/forge-logs/readonly-audit.mjs` 的方式，会话 `SET SESSION TRANSACTION READ ONLY` + `START TRANSACTION READ ONLY`，`transaction_read_only=1`，只执行 SELECT / information_schema，结束 ROLLBACK；脚本 `/tmp/forge-logs/ro-ops027-20261022.mjs`、`ro-ops027b-20261022.mjs`，输出 `/tmp/forge-logs/ro-ops027-20261022.log`；未改 `.env`、未重启服务、未输出任何密码）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 备份文件 | **pass** | `forge-full-pre-cleanup-20261022-1319.sql` 存在、`-rw-------`、sha256 `6ea2d63756de48e2…`；旧备份 `forge-pre-cleanup-20261022-1254.sql`（`d7a39bb8…`）、`…-1254-extra.sql`（`388d01f9…`）仍在，均 600 |
| 2 | 清理 SQL | **pass（偏差已留痕）** | `cleanup-it-20261022.sql` 与 `cleanup-exec.sql` 的 DELETE 语句逐行相同，单事务 `START TRANSACTION … COMMIT`；三个 SQL 文件里 `audit_logs` 出现 0 次（无 DELETE / UPDATE）；`cleanup-exec-result.txt` 行数与运维表逐项一致（users 2、service_accounts 23、agents 2、agent_versions 2、runs 9、run_steps 18、run_events 72、threads 12、messages 18、api_apps 4、api_keys 1、llm_providers 3、tool_sources 3、mcp_servers 3，其余 0）。父表 agents / api_apps / llm_providers / mcp_servers / tool_sources / users 均「按 id 且 `key`/`username` LIKE 'it-%'」，子表按父 id。**偏差**：`service_accounts` 不是按 id，而是 `key LIKE 'it-s%-mvj2axa5e11d43%'` + `created_at` 2 秒窗口（04:49:48～04:49:50 UTC，即 12:49:48～12:49:50 UTC+8）；仍限定 `it-` 前缀，现库 `service_accounts` 中 `it-` 前缀 0 行。**架构师裁定：结果可接受，但需留痕**——由运维从备份 `forge-full-pre-cleanup-20261022-1319.sql` 对出实际删除的 23 个 `service_accounts` id，写入 `cleanup-exec-result.txt`，状态「**已补**」（13:29 运维补入 `cleanup-exec-result.txt` 与 `sa-deleted-ids.txt`；QA 13:30 只读核对：23 行，key 均为 `it-` 前缀，23 个 id 均在备份中可查到）；以后清理一律先列 id 再按 id 删（OPS-027 清理规范） |
| 3 | 残留与危险地址 | **pass** | `it-` 前缀：users.username 0、users.email 0、service_accounts 0、agents 0、api_apps 0、llm_providers 0、tool_sources 0、mcp_servers 0、org_units 0。`169.254` / `file:` / 精确 `127.0.0.1:9(/\|$)`（不匹配 `:90xx`）在 llm_providers.base_url、tool_sources.base_url、mcp_servers.url、api_apps.webhook_url 均 0。仍含回环 / 内网地址的行：tool_sources **demo-http** `http://127.0.0.1:8090/api`（active，已知保留项）；mcp_servers **demo-mcp** `http://127.0.0.1:8090/mcp`（active，**架构师确认保留，与 demo-http 同为 8090 演示 mock**）；其他表无 |
| 4 | 12 表孤儿 | **pass** | information_schema 声明的外键 14 条 + 补查 threads.agent_id、schedules.service_account_id，覆盖 12 张表，孤儿合计 **0**；另查 api_keys→api_apps、agent_versions→agents 孤儿 0 |
| 5 | 审计 | **pass** | `audit_logs` = **306**（≥ 306）；13:19（UTC+8）之后新增 0 条（无 action 分布可报）；最新一条审计 12:50:52（UTC+8） |
| 6 | 3100 与 `.env` | **pass** | `lsof`：PID **81953**（启动于 13:20:22 UTC+8）只监听 `127.0.0.1:3100`；`curl 127.0.0.1:3100/readyz` 200、`/next/` 200；`ifconfig` 确认 en0 有 `10.10.58.51`，`curl 10.10.58.51:3100/readyz` 连接被拒（curl exit 7）；主仓 `/Users/libo/projects/forge` HEAD `543b664`；`.env` 与备份 `env-backup-20261022-1320`（600）变量名 diff 为空，HOST 由 `0.0.0.0` 改为 `127.0.0.1`，其余行逐字节相同（只比较、未输出值） |

**前置 / 注意**
- 修复 F 之后，会话每次请求都按用户 id 查库：测试会话**必须用真实用户**（`~/forge-qa-users.json` 里的种子用户）登录来造，不能再伪造或复用内存会话。
- 修复 G 上线后，开发用 `.env` 需由 **Cursor Jackson** 加上 `OUTBOUND_ALLOWLIST=127.0.0.1:8090`（mock 白名单），否则依赖 mock 的用例（PRE-MOCK）会被拦。测试实例（3197/3198 临时 `.env`）由测试 / 运维自行配置，不动开发 `.env`。
- OPS 文档项：白名单环境变量写进 `.env.example`，带注释，默认为空（见 §11 OPS-文档）。

## 13. 变更记录

| 日期 | 说明 |
|---|---|
| 2026-10-22 | 初稿 → inventory → UI → 威胁映射 |
| 2026-10-22 | 合入 OPS-001～023；补 UI-042a/b、UI-080～082 |
| 2026-10-22 | 合后端接口审阅（`b7bfce9`）：修 9 条错预期（W-01a～W-08）、标已知缺陷 K-01～K-08；按架构师口径改 I-SCOPE-10（统一子树规则）、I-RBAC-02（decide 同「审批不存在」）、UI-034/081、I-G-06/07；新增 S-45（会话快照）；O-08 / OPS-012 改为重启后会话失效属设计；OPS 用例换运维新版；新增 `api-cases-addendum.md`、`route-exec-matrix.md`（86 行）；威胁清单 T1 加 S-45、T5 加 I-INT-10 |
| 2026-10-22 | 合入安全专家批次：新增 S-38～S-44，S-10 改为逐项列安全响应头；会话快照改编号为 **S-45**（原号与安全专家「审计日志跨部门隔离」撞号）并定 P0；按架构师口径新增出站校验用例 S-46～S-49、改 I-MCP-02，全局可见按架构师建议写并标【待 Cursor Jackson 拍板】（新增 I-SCOPE-06），I-SCOPE-10c / I-SA-10 写正反两面，新增 I-APR-12 / I-APR-37 / I-APR-38，F-SM-02/04 补流转，已知限制见 §15.4。UX 批次（UI-053～057 改、UI-059 / 065～069 / 072～074 新增）已在 `7823da5` 合入 |
| 2026-10-22 | 合前端审阅（`fe-cases-review.md`）：新增 UI-083～092；卡片 / 表格分界改 1024；F-APR-10 只在 ≥1024 量行高；tabs 3px、shadcn -1px、sr-only 记已知例外；U-01～U-10 只留映射不单独计 fail；UI-050～058 / U-01～U-06 改为修复 `04ef9a8` 进基线后按实测记；F-LEG-* 只测 1280 / 1440，手机端 N/A，新增 F-LEG-M1。会话快照 S-45 按修复 F 补预期并新增 S-45b（查库失败 503）；新增 I-AUTH-09、I-INT-10b、F-SCH-14/15、F-SM-04a/b、S-48a～d；S-47 核对后保留；`ops-cases.md` 换新版并在 §11 加 OPS-024（含界面预期）/ OPS-025 / 白名单文档项；新增 §16 后端修复串复验清单（A～G） |
| 2026-10-22 | 合 UX 批次（`~/forge-baseline/ux-cases.md`）：改 UI-053/054、055、056、057，新增 UI-059、UI-065～069、UI-072～074；去掉 414 断点、触屏控件尺寸口径；编号无冲突；UI-072（375 部分）/ UI-073 / UI-089 改为映射行不单独计 fail。合后端执行表审阅（`matrix-review.md`）：`route-exec-matrix.md` 重构为 401 / 403 / 404 / 400 与边界 / 审计 action / 数据范围 / 备注列，全表写正确行为、现状进备注；全局前置「写接口测 401/403/CSRF 带合法 body」并新增 I-CSRF-06（K-09）；修失效引用（UI-034a/b、I-SCOPE-10、F-SCH-10/11、W-03、A5）；补 I-OPEN-11～14 / 22 / 23、I-INT-14～16、I-SKL-07、I-APP-08 / 09；I-APP-05 以 I-OPEN-02 为准；取消已结束 Run 三入口统一 409；I-AGT-11/11b/11c 定 409 CFG-8503，I-AGT-05 status 只收两值；重写 I-ERR-13/15/18/20，新增 I-SCH-17；I-INT-10 拆 10a～c（10b 用 `status:"deleted"`、10c 在 3197 `forge_connector` 改库），原 I-INT-10b（查库失败）改号 **I-INT-10d**；F-SCH-11c 补观察点；I-SCOPE-10c / I-SA-10 补子部门 SA 造法；§16 补 H 及之后的提交（已改名为 L～O，见下一行） |
| 2026-10-22 | I-SCOPE-10c / I-SA-10 前置改为「PA 建 SA → 运维在 3196 `forge_ops` 用 SQL 改 `org_unit_id`（先 SHOW CREATE TABLE、先备份、SQL 贴日志、禁用 forge / forge_ux、测完删库）」，反面用例同法；§15.4 加「建用户 / SA 不能指定部门」为 P2 功能缺陷及以后规则；后端修复提交（原「K」加数字的四个编号）改名为 **L / M / N / O**（已知缺陷编号 K-01～K-09 不变；I-ERR-15 的两把主密钥改称 KEY1 / KEY2）；执行表「数据范围」按架构师改 #16～#18、#21～#36、#49、#68、#83，新增 I-AGT-13、I-PLG-04、I-INT-17；行高定为 UI-057 通用规则（一行 44、两行 52、±1px），F-APR-10 改映射行 |
| 2026-10-22 | 按架构师 C 方案拆开平台资源写范围：执行表 #21～#25（model.manage）只有 PA 能写，OA / BL 403，现状越权记已知缺陷 **K-10（P1）**、新增 I-MDL-11、§16 补修复行；#27～#29、#31、#33、#34、#36（MCP / Skill / 工具源）目标为资源带归属部门，现状记**设计缺口 P2**（§15.4），本轮不按 fail 计；两类均保留【待 Cursor Jackson 拍板】、备注「架构师推荐 C 方案」。I-PLG-04 改为 OA 卸载其他部门插件 → 403 POL-2001 即 pass；现状卸载全局、不按部门判定，修复提交 **P**（O 之后）加 owner 部门子树判定、PA 不受限，四种单测（§16 待后端提交）；执行表 #68 同步（行号不变） |
| 2026-10-22 | §16 在 P 后加修复 **Q**（K-10 / I-MDL-11：收回 org_admin、builder 的 `model.manage`，待 Cursor Jackson 拍板方案 C，单独提交不并入 P），K-10 行、I-MDL-11、执行表 #21～#25 备注同步写 Q；fe-cases 新增 UI-093（OA / BL 改 Provider / 模型遇 403：提示无权限、不跳登录、不丢登录态）；§15.4 加「无写权限时隐藏编辑 / 删除按钮」本轮不测 |
| 2026-10-22 | UX 复核修正：删去「UX 批次未合入」等过时说法，改为「已在 `7823da5` 合入」（§15.6、变更记录）；F-APR-10 降为 P3（行高不影响功能，与 UI-057 一致）；UI-053 前置加 1024（表格布局）；UI-065 加 768；U-07 保留 Tabs 3px（shadcn 自带）为例外，但触屏 Tab 点击区须 ≥44 按 UI-054 测（修复前 29，`04ef9a8` 加 min-height 44，干净克隆复验结果作 UI-054 证据，仍为 29 计 fail） |
| 2026-10-22 | UI-093 替代验证改为 operator 在 Agents 页打开「开放 API」开关（`PATCH /admin/api/agents/:id` 需 agent.manage → 403；备选「发布」需 agent.publish），删去原「builder 审批中心点批准」建议；新增 UI-094（builder 打开审批中心，列表 403：表格内错误行 + 错误码 + 重试，不跳登录、不丢登录态、无「批准」按钮，P2） |
| 2026-10-22 | 前端核对代码更正：UI-093 删去「并确认」（「开放 API」开关不弹确认框、点击即发请求，403 后保持关闭）；UI-093 备选「发布」注明确认框不自动关闭不计入本条、由 UI-095 判，UI-093 只判错误提示 / 是否跳登录 / 登录态；新增 UI-095（P3，确认框内操作遇 401/403 应自动关闭，5xx / 网络错误可保留），现状记已知缺陷 **K-11** |
| 2026-10-22 | 合后端执行表第 2 轮逐格核对（`/tmp/forge-logs/matrix-review-2.md`）：改 403 角色列表（#42 BL/AU/US、#43 #49 AU/US、#64 BL/OP/US）、#16～#18 无主 Agent 403、#21～#25 OA/BL 403 越权 P1（#25 按写操作处理）、#82 补 401 AUTH-1001 与 503 SYS-9003（修复 I `fda5a74`）、#10 / #24 / #51 / #57 / #67 等格；审计 6 格定名（Y）。架构师裁定：开放重定向 P1（K-14，修复 R，S-30 五种写法回落 `/next/`）；修复提交改名 T / V / W / X（不用 S、U），新增 Y、Z；P 缩为「不存在 404 + OA 403 测试」，按部门判定下一轮；取消已结束 Run 定 **409 RUN-7005「Run 已结束，不能取消」**，CFG-8503 只用于「Agent 已停用」。写死 I-USR-01、I-RUN-06 / I-OPEN-23 / I-INT-16、I-SKL-07（K-12）、I-AGT-13、I-INT-17、I-APR-38（K-13）现状。合 `04ef9a8` 复验：UI-056 字号 K-15（P2）、UI-053/054 已知例外依据、UI-054 Tab 44 证据、U-07 复验 pass、新增 OPS-026a～c（K-16，修复 Z） |
| 2026-10-22 | OPS-026 / K-16 升为 **P0**，按架构师要求重写：守卫放 vitest `globalSetup`、只认 `TEST_DATABASE_URL`、库名非 `_test` 结尾报错（`FORGE_ALLOW_NON_TEST_DB=1` 放行），子用例 OPS-026a～f（含主工作区 `.env` 下 `pnpm test` 拒绝、种子 / 迁移写操作确认）；新增 **OPS-027（P0）** forge 库清理只读复核，备注记录 12:41 / 12:42 / 12:49（UTC+8）误写事故经过；§16 同步 |
| 2026-10-22 | OPS-027 加清理前只读前置检查（`it-rs-…` platform_admin 自 12:42 UTC+8 起的 sessions 与 `auth.login` 审计，非测试来源登录判 fail 并先按安全事件上报）；I-SKL-07 / K-12 修复定为 **T**，预期 400 CFG-8501 并同时断言码和文案；执行表 #12 #13 #15 #37 #38 #39 #85 的 403 标「未验（内置角色不可测，待后端报单测文件:行号）」 |
| 2026-10-22 | OPS-026f 按架构师口径改死（种子 / 迁移：`_test` / `_ux` 放行，其他库名须 `--confirm-db=<完全一致的库名>`，拆 f1～f3），新增 OPS-026g（vitest 拒绝 `forge_ux`）；§16 写明 Z、OPS-026、OPS-027 是冻结基线的前置条件，K-16 已定 P0。`ops-cases.md` 未改（运维自行加引用） |
| 2026-10-22 | OPS-026 删掉 `FORGE_ALLOW_NON_TEST_DB` 放行描述，vitest 不留绕过；新增 OPS-026h（`FORGE_ALLOW_NON_TEST_DB=1` + `…/forge` 仍拒绝）。OPS-027：孤儿行改按外键查 12 张表、去掉不存在的 sessions / user_roles；备份两个文件（`d7a39bb8…`、`388d01f9…`）；前置 PA 登录检查记 pass（运维只读查询）；新增待查项「种子 admin 每分钟 3 次登录」，查清前不清理。正文留在 §11（架构师定），`ops-cases.md` 未改 |
| 2026-10-22 | OPS-027 阻塞项「种子 admin 每分钟 3 次登录来源不明」改为**已查清**（运维只读结论：末次登录 12:50:52；12:44～12:50 为后端进程内测试直连 forge、未经 3100；3100 当天只有 11:19 前端故意输错密码 2 次；12:50:52 后 12 分钟无新审计，时间 UTC+8），前置条件只剩「需 Cursor Jackson 同意清理」；§16 同步 |
| 2026-10-22 | OPS-026 预期补充（架构师）：守卫须在应用建立数据库连接前拦截，不能只拦 HTTP；进程内 `buildApp` / `inject` 用种子 admin 连 forge 也拒绝；新增 OPS-026i（进程内启动指向 forge → 拒绝，forge 无新 audit_logs / 业务行）；§16 同步为 a～i。`ops-cases.md` 引用仍写 a～h，待运维改为 a～i |
| 2026-10-22 | §16 填入修复哈希 G～Z（L 续篇 `b038bd2`），I 原 `fda5a74` 标「已被 `1422152` 替换（疑为 rebase，待后端确认）」，QA 只读核对 17 个提交均在 `fix/blockers-authz-mask`；记后端自报结果（待 QA 复验）；新增修复 AB（哈希待后端）。I-APR-38 / K-13 改为 409 RUN-7005「Run 已结束，审批不可操作」、审批 `expired`（架构师已确认）。新增 OPS-026j（`db:reset` / migrate / seed 拒绝 `--yes` / `--force`，只写不执行），§16 范围 a～j。新增 I-USR-12（建用户 status，400 CFG-8501）。执行表 #12 #13 #15 #37 #38 #39 #85 改「未验（无单测覆盖…），待 API 实测覆盖」，新增 K-17（P2）。新增 I-SCOPE-13 / I-SCOPE-14（部门子树 LIKE 前缀误匹配，修复 AB；架构师指定的 I-SCOPE-11 / 12 已被占用，顺延）。integration 不检查 `api_enabled` 写为架构师定的边界 |
| 2026-10-22 | §16 补 AB `2244dbb`、AC `76bc68a`、OPS-026j 测试 `d8906a7`（QA 只读核对均在分支、顺序正确）；I 行注明 `fda5a74`→`1422152` 只改提交说明，tree 均为 `33af686`；记后端 13:18 自报（40 文件 629 过 2 跳过，待 QA 复验），跳过的 `tests/routes.test.ts:115`、`:120` 列为执行前置（先构建 dist 再复跑）；T 测试位置 `tests/status-whitelist.test.ts:54`。I-SCOPE-13/14 扩展（`a%`/`azz`、`q\`/`q\x`、`/x/b/c` 可见可改），新增 I-SCOPE-15（`/x/b` 停用不误判 `/x/bc`）。OPS-026i 补绕过 `vitest.config.ts`；OPS-026j 逐项写拒绝参数与 pnpm 传参限制。出站拦截统一 HTP-4003（架构师已确认，定稿），§15.2 按入口写预期，配置 400 / OIDC 502 / 运行期 `{ok:false}` / Run 以 HTP-4003 结束，每个入口断言不回显解析 IP；新增 S-50～S-53（S-52 / S-53 待后端实现）。`api-inventory.md` 改 #82 #83 与 R-run 写法 |
| 2026-10-22 | OPS-027 只读复核（QA，13:25～13:27 UTC+8）6 项结果写入 §16：备份、清理 SQL（service_accounts 按 key 模式 + 时间窗而非 id，记偏差）、残留 0、12 表孤儿 0、audit_logs 306、3100 只绑 127.0.0.1；审计判定改为「不少于清理前（306）」，加已知保留项 demo-http，demo-mcp 待确认。HTP-4003 改为「架构师已确认，定稿」。S-50 拆为 S-50a（管理端 JSON 502）/ S-50b（整页跳转 302 `ssoError`，P2，预计当前 fail），§15.2 同步。白名单变量定为 `OUTBOUND_ALLOWLIST`（修复 AD，哈希待填），新增 S-54～S-59。fe-cases 新增 F-LEG-12 / F-LEG-13（旧控制台出站拦截提示） |
| 2026-10-22 | OPS-027 / §16 复核表：demo-mcp 改为「架构师确认保留，与 demo-http 同为 8090 演示 mock」，第 3 项改为 pass；第 2 项偏差按架构师裁定「可接受但需留痕」，23 个 service_accounts id 由运维从备份对出写入 `cleanup-exec-result.txt`（待运维补）；OPS-027 加清理规范「先列 id 再按 id 删」。S-54 回归加入 demo-mcp（refresh / 工具调用） |
| 2026-10-22 | S-50b 按前端 `57e7aa6` 更新：固定文案与通用文案改为实际文案，补「超 64 字符忽略 / 无参数不提示」；跳回地址参数为 `redirect`（不是 `returnTo`），按 S-30 校验后才带；§15.2 同步 |
| 2026-10-22 | OPS-027 第 2 项：23 个 service_accounts id 运维已补（`sa-deleted-ids.txt`），QA 只读核对 23/23 在备份中、均 `it-` 前缀，状态改为「已补」 |
| 2026-10-22 | §16：AD = `6656f9f`（QA 只读核对在分支、接在 `d8906a7` 后），记后端 13:29 自报（42 文件 680 过 2 跳，待 QA 复验）；`git grep HTP-400` 只有 4001/4002/4003，HTP-4003 无重复；执行前提加 `forge_test` 迁移到 `005_webhook_error_code`；前端 `57e7aa6` 记入；加 AE 占位与范围冻结。S-30 / K-14 写明登录页跳回参数统一为 `redirect`，新增 UI-096（fe-cases）。S-50a 标「无此接口」（架构师已确认）；S-50b 记 AD 仍带 `returnTo`（`auth.ts:28-33`），待 AE，补三条断言。S-52 / S-53 去掉待实现，按 AD 写断言；新增 OPS-028（白名单格式非法启动失败）、OPS-029（迁移 005 只加列）。S-55 补 `localhost:8090` / IPv6，S-56 补跳 169.254，S-58 改为启动失败；S-54 引用 3100 切换顺序。OPS-027 事故说明按后端更正 |
| 2026-10-22 | §16：AE = `f825dc9`（父 `6656f9f`，QA 只读核对在分支，`auth.ts:34` 设 `redirect`），记后端 13:34 自报（42 文件 689 过 2 跳，待 QA 复验）；前端冻结点 `80a2a27`（父 `57e7aa6`，仅本地，只读核对）记入；冻结说明改为后端 `f825dc9`、前端 `80a2a27`。S-50b 去掉「待 AE」，按 Location 精确断言（`redirect` 先校验再编码、`/next/` 与不合法不带、不输出 `returnTo`、`//evil.example` 只含 `ssoError`），改为自报完成待复验。UI-096 补前端二次校验六种拒绝写法与回原页；新增 UI-097 与已知缺陷 **K-18（P2）**（SSO 入口不回原页，本轮预期落 `/next/`）。OPS-028 写入 AE 报错文案原文、混合样例、退出码非 0、`/readyz` 连不上。3100 切换目标提交改为 `f825dc9` |
