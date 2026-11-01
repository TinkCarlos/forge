# Assessment B — detector 与浏览器证据

本报告来自独立 B 子代理 `/root/console_evidence_b`。未查看 Assessment A、历史 critique 快照或 `.design-evidence` 报告。直到 parent 明确通知 A 已完成前，未向 parent 输出检测规则、数量或结论。仅做只读取证，未修改产品源码、配置或业务数据；未运行 Agent、审批、发布或操作凭据。

- 稳定目标：`/Users/libo/projects/forge/apps/console/src/main.tsx`。
- 模式：Operate；规范：`apps/console/DESIGN.md`；PRODUCT 缺失，未补造产品受众或品牌规则。
- 时间：2026-11-01；原始 JSON 中有 CDP 时间戳，截图与文件保留本次采集时间。Job 模块在采集期间存在并发开发，相关证据必须按时点理解。
- 浏览器：按已安装 ego-browser Skill 及 `ego-browser skill` v2.2.0 执行。复用唯一 TaskSpace 33，仅新建并操作独占 Page `p3`，未操作 p1/p2，未 finish 共享 TaskSpace。
- 环境：parent 启动的本地 API 3100、Vite 5175；共享 cookie 登录。parent 说明使用既有 `forge_test`，worker=false；不是生产。实际界面为 3 Agent、11 succeeded Run、0 待审批、0 Job。
- critique ignore：仓库 `.impeccable/critique/ignore.md` 不存在。

## 1. 单次 CLI 扫描

cwd：`/Users/libo/projects/forge/apps/console`

```text
/Users/libo/.agents/skills/impeccable/scripts/impeccable detect --json src public/index.html
```

两个目标在同一次调用完成，未重跑检测。目标树远少于 500 可扫描文件；工具不输出实际扫描文件数。退出码 **2**，原始 JSON **1 条 finding / 1 个规则**，未见 advisory 条目。

| 规则 | 严重度 | 文件/位置 | 原始判定 |
| --- | --- | --- | --- |
| `flat-type-hierarchy` | warning | `/Users/libo/projects/forge/apps/console/public/index.html`，CLI `line: 0`（没有有效源码行号） | body / h1 / h2 被识别为 16px，最大相邻比例 1.00:1 |

stderr 明确说明旧版 CSS 未被读到：HTML 引用 `/assets/styles.css`，静态扫描将它解析为不存在的 `public/assets/styles.css`；实际源码为 `public/styles.css`。因此静态颜色、自定义属性检测不完整。不能将 src 的零 finding 或总计一条解释成全站质量达标。

原始资料：

- `assessment-b-detector.json`
- `assessment-b-detector.stderr.txt`
- `assessment-b-detector-meta.json`

### CLI 误报复核

`flat-type-hierarchy` 是已验证的静态资源解析误报。真实旧版总览的 computed style 为 body **14px**、可见页面 h2 **24px**、卡片 h3 **15px**（隐藏登录 h1 为 30px）。24/14 约 **1.71**，24/15 为 **1.60**，并非扫描报告的全部 16px。

证据：`b/05-old-overview-evidence.json`；截图 `b/05-old-overview-1280x800.png`。无需为消除此误报改页面字号。

## 2. 浏览器覆盖与截图

所有列出的截图均通过 `view_image` 实际查看。高层 ego 新一轮 nodejs 会恢复原生 viewport；本次在截图同一轮、goto 后设置 CDP Emulation，再读取 innerWidth/innerHeight，避免把原生 1788×941 误称为目标尺寸。最终命名的尺寸均已纠正。

| 代表页面 | 实际入口与状态 | 核心截图 |
| --- | --- | --- |
| 新版 Agents | `3100/next/agents`，3 条数据；另在 5175 同页面注入 | `02-new-agents-1280x800.png`、`02-new-agents-1440x900.png` |
| 新版 Job 管理 | `5175/next/jobs` 及 3100 构建页，空列表；打开创建弹窗后关闭，未保存 | `03-new-jobs-1280x800.png`、`03-new-jobs-built-1280x800.png`、`03-new-jobs-editor-1280x800.png` |
| 新版审批中心 | `5175/next/approvals`，没有待审批调用 | `04-new-approvals-1280x800.png` |
| 旧版总览 | `3100/#dashboard`，11 条运行统计、待审批 0、运行中 0 | `05-old-overview-1280x800.png` |
| 旧版 Agents | `3100/#agents`，相同 3 Agent | `06-old-agents-1280x800.png`、`06-old-agents-1440x900.png` |

另有登录页 `01-new-signin-1280x800.png`。390×844 仅补充检查（移动不是本轮正式范围）：新版 Agent 转为竖排卡片，旧版保留局部 640px 表格横滚；两者 document scrollWidth 均为 390，没有整页横溢。证据为 `narrow-supplement.json` 与两个 `*-390x844-supplement.png`。这不等于完成移动验收。

## 3. 注入、浏览器规则与可见性

预检真实执行了 document.title 修改及追加 script 标签，并回收预检标签/变量。

- Vite 5175：title 可改、script 可追加、内联预检执行成功。
- API 构建页 3100：title 可改、script 可追加；产品 CSP `script-src 'self'` 阻止内联预检与 `http://localhost:8400/detect.js`。未绕过 CSP，未修改仓库 HTML。

预检成功后，按帮助执行 `impeccable live-server --background`，启动自己的 PID **56637** / 端口 **8400**。在 Vite 上对 **Agents / Job 管理 / 审批中心** 三个不同代表页注入并各等待 2.5 秒，用 ego 的 `egoAutomated.disable` + `Runtime.enable` 读取真实 console 消息。登录页额外注入结果为 0。

| 页面 | script / detector 状态 | console 与实际标注 |
| --- | --- | --- |
| 5175 Agents | loaded=true，detector 已执行 | 2 anti-patterns；`overused-font` + `nested-cards` |
| 5175 Job 管理 | loaded=true，detector 已执行 | 2 anti-patterns；相同两规则 |
| 5175 审批中心 | loaded=true，detector 已执行 | 2 anti-patterns；相同两规则 |
| 5175 登录 | loaded=true，detector 已执行 | `No anti-patterns found.` |
| 3100 新版 Agents | 外部 script failed=true，CSP 阻止 | 无可靠 overlay，不当成干净结果 |
| 3100 旧版总览 / Agents | 外部 script failed=true，CSP 阻止 | 无可靠 overlay，不当成干净结果 |

三页合计为 **6 次规则命中 / 2 个独立规则**；不是 6 个独立设计问题。浏览器规则位置是 DOM，不映射源码行：

- `overused-font`：`body`，主字体 Inter 占约 98% 文本。
- `nested-cards`：Agents / 审批的 `div.table-cards.overflow-hidden.rounded-lg.border.bg-card`；Job 的 `div.overflow-x-auto.rounded-md.border`。

### 浏览器误报/适用性判断

- **nested-cards：语义误报。** 框出的对象是表格边界；它外面的圆角区域是应用内容框架，不是第二张独立业务卡片。真实截图没有出现卡片层层套叠导致的任务结构混乱。不应仅因该规则删除有助于扫描表格的边界。
- **overused-font：Operate 场景的弱信号，不列为产品缺陷。** Inter 在控制台中是清楚一致的界面字体。此次没有品牌文档要求更有表现力的字体，也没有证据表明它妨碍完成任务；不建议为了规则改字体。

脚本运行成功且可见标注已实际截图：`02-new-agents-overlay-1280x800.png`、`07-human-overlay-1440x900.png`。B 收束时 p3 标题为 **`[Human] Forge Console — B evidence`**，在 5175 Agents 留有已执行的标注；parent 随后可能统一关闭 TaskSpace，因此最终答复若已关闭，应写“标注截图已存档”，不要继续声称用户当前可见。3100 的产品构建页始终没有可靠 overlay。

原始 console / status 分别在 `01-new-signin-injection.json`、`02-new-agents-injection.json`、`03-new-jobs-evidence.json`、`04-new-approvals-evidence.json`、`02-new-agents-built-evidence.json`、两个旧版 `*-evidence.json` 与 `07-human-overlay-evidence.json`。

## 4. 自动规则未捕捉的手工证据

以下为 B 的可复核证据，供 parent 与 A 合成，避免只围绕三个误报讨论。

### [P2] 1280×800 时新版最后一项导航被裁切

规范要求“1280×800 下完整导航可见”。实际平台管理员侧栏内容视窗为 y=72–728、clientHeight 656、scrollHeight 692；最后的 **SSO / Connector** 链接为 y=732–764，完全位于裁切区外。凭据是首屏最后一个可见入口。1440×900 时该入口完整出现，因此是高度预算问题；可通过滚动找回，并非入口失效。

证据：`02-new-agents-built-evidence.json` 的 sidebar1280（逐项链接矩形与 fullyVisible）；1280 / 1440 两张新版 Agent 截图。最新 Job 导航增加占用空间，与 parent 说明的并发模块有关。建议重新核算分组留白或导航高度，不要隐藏功能入口。

### [P2] 旧版 Agent 桌面表格在 1280 下挤碎短状态词

同一 3 条数据在 1280×800 中，“未发布”被排为“未发 / 布”，“未开放”状态 pill 被排为“未开 / 放”；首行 5 个操作让详情换到第二行。1440×900 时这些短词恢复一行。新版将 Key 放名称下方并收纳次要操作，明显更易扫描。

证据：`06-old-agents-1280x800.png` 与 `06-old-agents-1440x900.png`。这是旧版表格的宽度分配/操作密度问题，不能归因于静态 detector 所报的字号层级。建议为短状态/版本留最小宽度，并用现有的次要操作收纳模式减少行内按钮。

### 时点观察，不作为当前缺陷：Job 弹窗关闭焦点

3100 当时构建页实测：打开“创建任务”后 Escape 关闭，等待 300ms 后 activeElement 仍为 BODY，未回到触发按钮。两次观察一致，原始文件 `03-new-jobs-editor-evidence.json`、`03-new-jobs-focus-recheck.json`。

但是 B 收束时当前 `src/features/jobs/index.tsx` 已因并发开发新增 `restoreDialogFocus` 与 opener 记录，和初读/构建页版本不同。按照 parent 要求不继续追逐进行中模块，**该观察仅保留为旧构建时点证据，不能直接列为“当前源码仍有焦点缺陷”**。需要负责该模块的工作在其最终构建上复核。

Job 创建表单另可见：必填 Key、业务类型、空的执行目标选择器和 JSON 配置缺少解释/占位内容；截图可供 A 判断认知负担。一次下拉探查没有形成完整结构化结果（脚本未返回预期输出，后续快照仍见表单）；未据此断言目标接口为空、选择器损坏或功能不可用。

## 5. 清理与限制

- 已严格执行 `/Users/libo/.agents/skills/impeccable/scripts/impeccable live-server stop --keep-inject`，cwd 为 apps/console；退出 0，返回 `Stopped live server on port 8400.`。没有使用裸 stop，没有对项目 entry HTML 执行注入删除。
- stop 返回的瞬间 PID/端口尚存在；随后复核 **端口拒绝连接、ps 找不到 PID 56637**，cleanupVerified=true。完整记录 `b/live-server-cleanup.json`。
- 含临时连接 token 的后台启动 JSON 已删除；无用的未完成下拉探查截图已删除。原始检测、console、截图和本报告作为交付证据保留。仅清理 B 自己创建的进程和临时文件，未触碰 parent 的 API/Vite。
- 未 finish 共享 TaskSpace。p3 留给 parent 统一管理；没有打开、关闭或操作其他 Page。
- 未跑代码测试/构建：本任务是只读 critique，应用由 parent 准备并构建。未跑业务动作、保存表单、创建测试数据或更改凭据。
- 数据没有待审批项、没有 Job，无法验证审批确认/驳回、非空 Job 行操作和相关成功/失败/权限状态。没有正式 screen reader、对比度测量或全键盘流程审计；不可把 detector 的少量结果当成这些方面通过。
- 5175 的 `/#旧版` 链接缺少根代理是开发入口差异；未把它作为产品生产缺陷。正式同源浏览器证据采用 3100；CSP 阻止注入是预期安全边界。
- CLI 为一次时点扫描，Job 模块之后的并发变动未重新扫描，未声明它覆盖收束时所有新代码。

Questions skipped: B 仅提交独立证据；完整 critique 的合成、持久化和结尾问题由 parent 执行。
