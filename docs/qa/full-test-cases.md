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
| §2 接口与错误码 | 后端（底稿 `api-inventory.md`） | 待审；inventory 未齐前用路由基线 86 条 |
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
| F-APR-10 | 样式 | P1 | 桌面 | 测行高 | 有参/无参行均为 52px |
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
| F-SM-02 | Approval | pending→approved/rejected；过期（若有） | P1 |
| F-SM-03 | Agent 版本 | draft→published；开放 API on/off | P1 |
| F-SM-04 | Schedule | enabled↔disabled；manual run；失败计数（若展示） | P1 |

---

## 2. 接口用例

> 完整 86 条路由以 `tests/fixtures/routes-baseline.txt` 为准（`4c2555e` 起）。后端 `api-inventory.md` 到位后，本表「权限 key」列与之对齐。  
> **矩阵符号**：✓ 允许（2xx/业务 4xx）· ✗ 403 · ◌ 404（跨范围）· — 未登录 401

### 2.1 全局接口规则

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| I-G-01 | 接口 | P0 | 无 cookie 调所有 `/admin/api/*` | 401 |
| I-G-02 | 接口 | P0 | 篡改 `forge_session` 签名 | 401 |
| I-G-03 | 接口 | P0 | 过期会话 | 401 |
| I-G-04 | 接口 | P0 | 有会话但无/错 `X-CSRF-Token` 的 POST/PATCH | 403 CSRF |
| I-G-05 | 接口 | P1 | GET 带错 CSRF | 仍 200（GET 不校验） |
| I-G-06 | 边界 | P1 | body > 2MB | 413 或框架等价，无崩溃 |
| I-G-07 | 异常 | P1 | `Content-Type: application/json` + 非法 JSON | 400，无堆栈 |
| I-G-08 | 接口 | P1 | 每个写操作成功后 | `GET /admin/api/audit` 有对应 action |
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
| I-APR-07 | 安全 | P1 | `page=1' OR '1'='1` | 400 或安全忽略，不 500 |

### 2.3 `args_preview` 回归（已有 59 单测，执行期抽 API）

| ID | 类型 | P | 预期 |
|---|---|---|---|
| I-APR-10 | 接口 | P0 | 列表中假数据两条打码规则与 `tests/args-preview-edge.test.ts` 一致 |
| I-APR-11 | 接口 | P1 | 残缺 JSON 值整体 `***`；`[草稿] 周报` / `{名字} 你好` 原样 |

### 2.4 角色 × 权限矩阵（抽样主路径；全量见 inventory）

对每个 `/admin/api` 路由，用 PA/OA/BL/OP/AU/US/OO 各调一次：

| ID | 覆盖 | P | 预期 |
|---|---|---|---|
| I-RBAC-01 | 权限矩阵 | P0 | 无权限 → 403；有权限 → 非 403（校验失败可以是 400） |
| I-RBAC-02 | OO 对根部门 Agent/Run/Schedule/Approval | P0 | 列表不含；按 id GET/PATCH/决定 → 404（与不存在同形） |
| I-RBAC-03 | US 调 `approval.decide` / `user.manage` | P0 | 403 |
| I-RBAC-04 | BL 调 `approval.decide` | P0 | 403 |
| I-RBAC-05 | AU 无 `schedule.view` | P0 | schedules GET 403 |
| I-RBAC-06 | OA 不能授 `platform_admin`/`org_admin` | P1 | 403 |
| I-RBAC-07 | `plugin.uninstall` / `service_account.*` / `sso.manage` / `role.view` | P1 | 仅 PA（或文档角色）允许；其余 403——**与 ROLE_PERMISSIONS 不一致处记缺陷** |

### 2.5 资源范围（已知风险，必须用例化）

| ID | 类型 | P | 步骤 | 预期（产品确认前按「应隔离」写，不符则 fail） |
|---|---|---|---|---|
| I-SCOPE-01 | 安全/接口 | P0 | OO：`GET /admin/api/users` | 仅本部门用户（当前实现若返回全站 → **缺陷**） |
| I-SCOPE-02 | 安全/接口 | P0 | OO：`PATCH` 根部门用户 | 404/403（若 200 → **缺陷**） |
| I-SCOPE-03 | 安全/接口 | P0 | OO：`GET /admin/api/dashboard` | 统计仅本部门（若含他部 pending/agents → **缺陷**） |
| I-SCOPE-04 | 安全/接口 | P0 | OO：对根部门 `apps/:id/keys` POST | 404/403（若 200 建出 key → **缺陷**） |
| I-SCOPE-05 | 接口 | P1 | OO：skills/mcp/providers 全局共享若为设计 | 文档写明；否则应隔离——**架构师确认** |

### 2.6 Open / Integration

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| I-OPEN-01 | 接口 | P0 | 无 key 调 `/open/v1/agents` 与 invoke | 401 |
| I-OPEN-02 | 接口 | P0 | 错误/过期 key | 401，消息不枚举 |
| I-OPEN-03 | 接口 | P1 | 合法 key 调已开放 Agent | 按文档 2xx |
| I-OPEN-04 | 接口 | P1 | `/integration/v1/*` 无凭证 | 401 |

### 2.7 接口清单勾选

执行时对 `routes-baseline.txt` 86 行逐行打勾（另表 `docs/qa/api-execution-sheet.md`，执行阶段生成）。每行至少：未登录、一拒绝角色、一允许角色、非法参数（若有 body）。

---

## 3. 安全用例

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| S-01 | 安全 | P0 | CSRF 见 I-G-04 | 写操作无 token 拒绝 |
| S-02 | 安全 | P0 | Cookie 无 `HttpOnly` 则 fail；生产缺 `Secure` 记缺陷 | 开发环境 Secure 可关，需文档说明 |
| S-03 | 安全 | P0 | 登录错误消息统一 | 防用户枚举 |
| S-04 | 安全 | P0 | 登录爆破 20+ 次/分钟 | 应限流或锁定；**无则缺陷**（运维/安全确认现状） |
| S-05 | 安全 | P0 | Agent 名存 `<script>…`，新/旧 UI 展示 | 文本转义，不执行 |
| S-06 | 安全 | P0 | 审批 args 含脚本/HTML | 仅文本展示 |
| S-07 | 安全 | P0 | SQL 注入字符进 query/body | 400/转义，表还在 |
| S-08 | 安全 | P0 | `/next/../`、`%2e%2e` 路径穿越 | 不读仓库外文件 |
| S-09 | 安全 | P0 | 响应/审计/服务日志无口令、Bearer、`sk-`、`fsk_` 明文 | grep 抽查 |
| S-10 | 安全 | P1 | 安全头：`X-Content-Type-Options`、`X-Frame-Options`/`frame-ancestors`、CSP | 缺则记建议或严重（架构师定级） |
| S-11 | 安全 | P1 | CORS：浏览器跨站带 cookie 写 admin | 应失败 |
| S-12 | 安全 | P0 | IDOR：换 approval/run/agent id 跨部门 | 404 |
| S-13 | 安全 | P1 | 依赖扫描（安全专家） | 高危 0 或有缓解说明 |
| S-14 | 安全 | P1 | 会话仅内存 Map：重启后 cookie 失效 | 符合设计；多实例粘滞风险记文档 |

---

## 4. 样式与响应式

断点：**375 / 390 / 768 / 1280 / 1440**；主题：浅 + 深。前端已审一版，用例对齐其 P1–P3。

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| U-01 | 样式 | P1 | 390/768 Agents、审批表 | 主操作（发布/开关/批准）首屏可达，无需盲横滑；或明确卡片布局 |
| U-02 | 样式 | P1 | 768 | 侧栏默认图标模式或可收起，不吃掉 1/3 内容区 |
| U-03 | 样式 | P2 | 触控目标 | 手机 ≥44px；桌面复制/关闭 ≥24px |
| U-04 | 样式 | P2 | 浅色 `muted-foreground` | 对比度 ≥4.5:1（axe） |
| U-05 | 样式 | P3 | ⌘K 提示字号 | ≥12px |
| U-06 | 样式 | P3 | favicon | 无 404 |
| U-07 | 样式 | P3 | Tab padding 3px | 记入 4px 网格债或改 |
| U-08 | 样式 | P1 | 1440/1280 浅+深 | 间距抽查关键组件为 4 的倍数；无意外重叠 |
| U-09 | 样式 | P1 | 减少动态效果 | 同 F-APR-11 |
| U-10 | 样式 | P1 | 5 个确认弹窗焦点归还 | Esc/取消/确认（行消失→h1） |

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
| O-08 | 运维 | P1 | 重启 API | 定时任务恢复策略符合设计；内存会话失效 | 运维 |
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
| Q1 | apps / skills / mcp / providers / audit / dashboard / users 标「全局」：是设计还是缺陷？OO 改根部门 app/key 算不算越权？ | 架构师 | inventory §0.5、§4.C.20、可疑点 3 |
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
| S-22 | #3 跨部门 apps/keys | P0 | OO：读/改根部门 app、签发 key、replay webhook | 应 403/404；若 200 → 缺陷 |
| S-23 | #4 integration | P0 | 合法 Connector JWT（映射普通用户）调 `GET /integration/v1/agents`、`POST .../runs` | 记录实际可见范围与是否写审计；默认预期：应按映射用户数据范围限制且写审计——不符则缺陷 |
| S-24 | #5 app token 调 admin | P1 | `Authorization: Bearer fsk_…` 调 `GET /admin/api/runs` | 401 AUTH-1001（不认 Bearer） |
| S-25 | #6 参数 500 | P1 | `runs?limit=abc`、`audit?limit=-1`、坏 JSON、3MiB body、非法 cron 且 active | 期望 400；若 500 SYS-9001 → 缺陷（可降 P2 若仅内部） |
| S-26 | #7 报错泄露 | P1 | MCP create 失败、provider test 失败 | 响应 `warning`/`error` 不应含内网地址/SQL；日志可有完整错误但无口令 |
| S-27 | #8 审计缺口 | P1 | enable/disable schedule、open/integration cancel、integration 建 run | 成功后 audit 应有记录——无则缺陷或改文档 |
| S-28 | #9 会话不失效 | P0 | PA 停用某用户后，该用户旧会话调 API | 应 401；若仍 200 → 缺陷 |
| S-29 | #10 plugin 部分写入 | P1 | install 缺顶层 key（先建子资源） | 应事务回滚或补偿；残留无审计 → 缺陷 |
| S-30 | #11 OIDC returnTo | P0 | `/auth/oidc/login?returnTo=//evil.example` | 应拒绝；若 302 到外域 → 开放重定向缺陷 |
| S-31 | Run 详情不打码 | P0 | builder/auditor/user 调 `GET /runs/:id` 含敏感 tool args | 应打码或 403；原文暴露 → 缺陷 |
| S-32 | 登录时序 | P2 | 邮箱不存在 vs 密码错误的耗时 | 记录差值；过大则记建议 |

### 8.3 文档 vs 代码（验收口径）

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| I-DOC-01 | 接口 | P2 | 抽查 10 条 admin 路径 | 实际为 `/admin/api`；文档差异记「文档债」，不挡功能 pass |
| I-DOC-02 | 接口 | P1 | 错误体字段 | 有 `retryable`，无 `remedy` |
| I-DOC-03 | 接口 | P1 | 创建类 POST | HTTP 200（非 201），除非 open runs=202 |
| I-DOC-04 | 接口 | P2 | 文档有、代码无的码（APR-2103 等 11 个） | 不出现在响应；报告列「仅文档」 |
| I-DOC-05 | 接口 | P1 | 仅 PA 的 6 个权限 key | OA/BL 调对应接口 → 403；与 ROLE_PERMISSIONS 表一致即 pass |

### 8.4 数据范围细则

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| I-SCOPE-10 | 接口 | P1 | 子部门用户看父部门 schedule | R-sched 为精确等于：应不可见（与 runs 子树规则不同） |
| I-SCOPE-11 | 接口 | P1 | `self` 用户看 Agent 列表 | 与 `org` 相同（按部门子树），不是「仅自己创建」 |
| I-SCOPE-12 | 接口 | P1 | owner=NULL 的 Agent：列表空部门用户 vs 详情 | 列表/详情一致性；不一致记缺陷 |

### 8.5 执行表

冻结后生成 `docs/qa/api-execution-sheet.md`：86 行 ×（未登录 / 拒绝角色 / 允许角色 / 非法参），勾选来源 inventory 编号 #1–#86。

---

## 9. 前端用例合入（UI-001～UI-071）

完整底稿：`docs/qa/fe-cases.md`（前端提供）。与 §1/§4 重叠时**以 UI 编号为执行主编号**，F-/U- 作为交叉引用。

| 说明 | 处理 |
|---|---|
| UI-001 预期「跳转仪表盘」 | 新控制台登录后默认进 `/next/agents`（无独立仪表盘页）→ 预期改为「进入 Agents 或已实现的落地页」，记 **UI-001'** |
| UI-021 Agents 分页 | 代码列表无分页（inventory）：造 0/1/大量条测滚动/空态；「每页条数」若 UI 无控件则标 N/A |
| UI-025 Agents 详情 | `/next` 若尚未做详情路由，则「旧控制台详情 + ⋯菜单跳转」满足即 pass，缺页记缺口 |
| UI-032 | 同时覆盖审批预览打码 **与** 运行详情（旧控制台 Run）敏感字段；与 S-31 捆绑，任一侧明文即 fail |
| UI-050～058 | 基线 `543b664` **预期 fail**（修复在 `fe/responsive` `1ae3963`，开测前若已推入 main 则改预期） |

执行清单（按模块）：UI-001～006 登录会话 · UI-010～014 导航 · UI-020～025 Agents · UI-030～034 审批 · UI-040～043 通用异常/XSS · UI-050～058 响应式样式 · UI-060～064 无障碍动效 · UI-070～071 主题兼容。

## 10. 威胁清单映射后的新增用例

| ID | 类型 | P | 步骤 | 预期 |
|---|---|---|---|---|
| S-33 | 安全 | P1 | 登录前记下匿名 cookie（若有）；登录成功后再看 `forge_session` | 登录后 token 与登录前不同（防固定） |
| S-34 | 安全 | P1 | Connector 开关关：带任意 Bearer 调 `/integration/v1/agents` | 503 CON-4703（或文档码） |
| S-35 | 安全 | P1 | 开关开：签名有效但映射用户无 `agent.run`，`POST /integration/v1/runs` | 期望 403；若 202 → 缺陷（Q6） |
| S-36 | 安全 | P1 | 有效调用 integration 写接口后查 audit | 应有记录；无则缺陷 |
| S-37 | 安全 | P2 | open 列表若含 cursor：篡改 cursor | 不可看到他应用数据 |
| F-SCH-10 | 功能 | P1 | 绑定 platform_admin 服务账号创建/更新 schedule | 400 或 409 SCD-4804（以代码为准，记文档差） |
| F-SCH-11 | 功能 | P1 | 服务账号 disabled 后 trigger/manual run | SCD-4801，任务暂停 |
| F-SCH-12 | 功能 | P1 | 并发手动 run 触发 skip | 409 SCD-4802 |
| F-SCH-13 | 日志 | P1 | OA 点手动 run | audit 含操作者用户 id + 执行用服务账号 id |
| O-11 | 运维 | P1 | 检查 3100 监听地址 | 记录 0.0.0.0 vs 127.0.0.1；改 HOST 需 Cursor Jackson 批准（群里已有卡片） |

威胁映射表：`docs/qa/threat-model.md`。

## 11. 运维用例合入（OPS-001～OPS-023）

完整底稿：`docs/qa/ops-cases.md`。执行用临时端口 **3196** + 库 `forge_ops`，不碰 3100/3197/3198/3199。

与原 §5 O-* 对照：O-01～O-10 并入 OPS-001～023；**以 OPS 编号为准**。

| 重点 | 说明 |
|---|---|
| OPS-014 | 日志脱敏：步骤含 URL query 密钥 + 主动 log 的错误对象；有明文则定 P0。修复方向：共用 args-preview 判定 + pino `redact`（架构师意见） |
| OPS-012 | kill -9 后会话「仍有效」与当前**内存会话**设计冲突——执行时记录实际行为；若会话失效则改预期为「需重登」，并单列「多实例粘滞」建议 |
| OPS-021 | 与群里 HOST 卡片联动；Cursor Jackson 未批准前只记录现状 |

## 12. 架构师横向补洞（合并进 UI / F）

| ID | 来源 | P | 步骤 | 预期 |
|---|---|---|---|---|
| UI-042a | 扩 UI-042 | P0 | 分别用 PA / OA / 部门成员(BL或OP) / AU(只读) 登录，走侧栏各页与关键按钮 | 与角色×接口矩阵一致：无权限入口隐藏或禁用；直打 API 403 有中文提示 |
| UI-042b | 地址栏越权 | P0 | OA 或部门成员：URL 换成他部 Agent id / 审批 id（新控制台若无详情则旧控制台/`/admin/api`+UI） | 与「不存在」相同的 404 空态，**不露出名称** |
| UI-080 | 状态：重复发布 | P1 | 已发布 Agent 再点发布（或两标签同时确认发布） | 一方成功；另一方可理解冲突/已发布，不双份脏数据 |
| UI-081 | 状态：过期瞬间批准 | P1 | A 标签看将过期审批；过期时刻 B 点批准 | 提示已过期/不可处理，**不能**成功批准 |
| UI-082 | 会话：多标签退出 | P0 | A 退出登录后，B 标签立刻点批准/发布等写操作 | 跳转登录；写请求失败（401），服务端无成功副作用 |

## 13. 变更记录

| 日期 | 说明 |
|---|---|
| 2026-10-22 | 初稿 → inventory → UI → 威胁映射 |
| 2026-10-22 | 合入 OPS-001～023；补 UI-042a/b、UI-080～082 |
