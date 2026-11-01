# 流程与回归面审查

审查模式：只读单面，未派代理、未改源码、未访问数据库、未开服务、未操作浏览器。

范围：以 `/tmp/forge-console-fixes-20261101/baseline/` 和 `our-changes.patch` 固定本轮范围，再读取当前源码与必要直接调用方。未使用整个仓库工作区 diff；未审模型/Spec 编辑同步、凭据目录、进行中的 Job/消息模块。权威 Spec 为本轮 `2026-11-01T05-29-22Z__src-main-tsx.md` 五项建议与 `admin-console.md` 顶部体验修复段。

## 尚未关闭的发现（2026-11-01 13:55 本地取证时点）

1. **[P1，高置信度] 旧版审批决定前仍缺少工具与脱敏上下文。** `apps/console/public/app.js:1646` 的 `decideApproval` 对普通 `policy` 审批只渲染备注框；工具名、`args_preview`、到期时间和执行证据入口均未进入确认框。旧版列表 `:684–685` 也没有工具/参数。管理员可直接批准实际工具调用，却看不到服务端已返回的工具与脱敏参数；`admin-console.md:7` 明确要求新旧审批在决定前提供这些信息。API `apps/api/src/routes/admin/runs.ts:85–94` 已提供 `tool_name` 与 `args_preview`，新版 `features/approvals/index.tsx:240–249` 已展示。最小修法：旧版决定框复用当前审批数据展示工具、原因、脱敏参数、到期；仅有 `run.view` 时提供具体 Run 的证据入口，不新增数据请求或权限。补普通策略、中断、无 `run.view` 的确认框断言。

2. **[P2，高置信度] 旧版名称入口关闭后无法再次打开同一 Agent。** `apps/console/public/app.js:472` 新增名称链接仅设置 `#agents/:id`，依赖 `hashchange` 打开详情。详情关闭后路由未清空；再点同一名称不会触发 hash 变化，且 `onHashChange` 在 `:341` 明确忽略与 `state.route` 相同的路由。结果是名称第一次可用，关闭后第二次无响应，必须改用“更多 → 配置详情”。最小修法：名称点击走显式委托并调用 `switchTab('agents/:id')`（阻止浏览器默认跳转），或在关闭详情时一致恢复列表路由。补“名称打开 → 关闭 → 同名称重开”回归断言。

以上两项已即时回传 Lead；Lead 表示会修复，需对具体增量复审后才关闭。

## 已核实并关闭的候选

本轮初始 patch 把新版本入口从 `agent.publish` 改为 `agent.manage`，与现有 `POST /admin/api/agents/:id/versions` 的 `agent.publish` 要求不符。Lead 已将列表 `app.js:479` 与详情 `:1465` 恢复为 `agent.publish`。独立 harness 验证当前 manage-only 用户无新版本入口，publish-only 用户有入口，与 unchanged API 契约一致；不计未解决发现。

## 实际检查的关键链路

- 新建与新版本：当前保存按钮为“保存草稿”，请求固定 `publish:false`；API 只有 `publish:true` 才更新线上指针。独立发布仍经目标版本与线上影响确认、携带 revision 与 `versionId`。
- 试运行：先读取该 Agent 的版本目录，默认优先草稿；用户选择的草稿/已发布 `versionId` 原样传给 Run 创建接口。缺版本与非法选择被拦截；原有空输入、原样文本与失败留框行为保留。
- React Agent 名称与行内主入口通过合法实体深链进入旧版可读详情；新建顶栏入口为 `/#agents/new`；详情的指令、模型、工具、Skill、预算、线上版本先展示，完整 JSON 在折叠区。
- React 审批菜单与决定框跳具体 `/#runs/:id`，无 `run.view` 时不展示证据入口；旧版直接按钮本来即按当前 `run_id` 调用详情。新 Run 深链不依赖目标出现在最近 100 条列表。
- Run 详情保持原消息/工具渲染与 SSE/REST 同步链，新增固定版本和请求摘要，布局改为单列消息，工具与事件默认折叠；CSS 对消息、诊断列使用 `min-width:0` 与自身换行/滚动。
- 旧版 Agent 次要操作收纳为原生 details；短状态 nowrap。React 导航使用 gap-0，保留 `SidebarContent` 的 overflow-auto。具体 1280×800、矮窗、窄屏与键盘交互效果须真实浏览器验收。

## 验证与缺口

独立执行以下 6 个测试文件，**74 项全部通过**（2026-11-01 13:54:52）：`agent-draft-workflow`、`app-agent-deeplink`、`app-agent-run-required`、`app-approval-resolved`、`app-cancel-requested`、`legacy-link`。另执行无浏览器 Node assert harness，核实修后的新版本门控及上述两个遗漏的当前触发条件。既有测试未覆盖旧版确认框完整上下文与关闭后同名重开，所以全绿没有排除这两项。

没有操作真实浏览器，也不把源码/Mock 测试当成界面验收。当前链路的保存→读回→选草稿试运行→独立发布、同名重复进入、审批证据入口、Run 阅读与导航尺寸均由 Lead 的最新真实浏览器验收补证；本报告不声称部署或生产验收。

**Standards：通过（本面静态范围，未发现未关闭的规范违例）。Spec：不通过（上述两项当前遗漏）；其它静态覆盖成立，真实可用性待验证。运行时验收：未跑。**

---

## 增量复审（2026-11-01 14:07，以下结论取代前轮未关闭状态）

### 前轮两项已关闭

- 旧版 `decideApproval` 现于 `app.js:1655–1658` 用同一条审批数据展示 Agent、工具、风险/中断原因、到期、脱敏参数和不可撤回说明；仅 `run.view` 允许时显示包含真实 `run_id` 的同源新标签证据链接。独立 Node assert 以有/无 `run.view` 两种角色核实：工具/参数转义、时限、精确链接与隐藏行为均符合当前 Spec，不额外读取 Run 数据。
- 旧版名称现带 `data-action="agent-detail"`（`:472`）；委托 `:927` 阻止默认跳转并显式调用 `switchTab`，同一路由也会重新加载并打开详情。新增定向测试实际执行两次 click 并断言两次导航，已通过。保留的 href 仍提供可复制的对象深链。

本次重新执行 7 个关联测试文件，**117 项全部通过**（14:06:03）：前轮草稿/版本/取消相关测试，加 `app-takeover-approvals` 和 `app-run-sse`。没有重跑无改动的其它审查面或冒充真实浏览器验收。

### [P2，高置信度] 关联现有缺陷：Run 终态只更新弹窗，列表仍停留在旧状态

Lead 本轮真实浏览器已复现：试运行成功且详情弹窗成功，底层列表仍为 queued 并提供取消按钮；权威 GET 也已为成功。本面未操作浏览器，独立用当前函数执行链复现同样的前端状态失配。

根因：`connectRunStream` 的终态事件分支 `app.js:2039–2043` 调 `syncRunFromRest`；后者 `:2081–2088` 读取权威详情并只调用 `renderRunView`。`renderRunView:1979–1985` 只更新弹窗 toolbar/messages/tools，既不更新 `state.runs` 也不重绘 `#content`。初次 `switchTab('runs')` 得到的 queued 列表因此持续保留。`renderRuns:635–645` 当前只会在切页、手动刷新或 `cancelRun` 完成时重新读取，终态没有触发它。这是关联既有问题，Lead 已显式纳入本轮增量修复范围。

**最小安全修点：** 在 `syncRunFromRest` 已通过 `state.runView` / ticket 校验、且 REST status 为终态的分支，若当前 tab 仍为 runs，刷新 `renderRuns`；不要调用 `renderCurrent` / `refreshCurrent`（会 `closeStream` 并清空当前 Run view）。同时 `renderRuns` 在请求前记录 navigation 和递增请求 ticket，响应后仅当 navigation、tab 与 ticket 仍匹配时修改 `state.runs` 和 DOM。这两项保护分别避免迟到响应覆盖后来页面，以及取消后较早的 running 列表响应覆盖较新的终态响应。若选择复用当前详情快照 merge 已有列表行再纯渲染，也可避免第二次请求，但需提取现有列表渲染段，diff 更大。

不要在每个终态事件中分别补刷新：共享 REST 同步点同时覆盖成功、失败、取消、预算耗尽，以及断线重取才发现终态的路径。初始打开时详情已经终态、列表仍旧的组合也要覆盖；可用同一权威详情快照同步列表，或验证既有终态事件回放确实完成列表更新。

**只读 self-check：** `/tmp/forge-console-fixes-20261101/run-list-sync-selfcheck.mjs`。脚本执行当前源码证明“modal succeeded、列表 queued”；只在内存中模拟上述最小修点后，四种终态、非 runs 页不刷新、导航后响应迟到、较旧列表响应迟到全部断言通过。此为候选修法验证，不代表产品源码已经修复。取证时点当前 `renderRuns` / `syncRunFromRest` 尚未包含该修复。

### 当前结论与剩余证据

**Standards：通过（本面静态审查，未发现当前新增的规范违例）。Spec：不通过（前轮两项已关闭；新增关联的终态列表一致性问题待修），其它已审静态覆盖成立、真实用户可用性仍待 Lead 验收。运行时验收：本面未跑。**

需要补证：当前产品源码的终态同步修复与相应回归；最新真实页面上的保存→读回→选择草稿/线上试运行→独立发布、同名重开、审批跳精确 Run、Run 终态列表与弹窗一致，以及 1280×800/矮窗/窄屏阅读和键盘可达。未审其它并发工作，未提交、推送或部署。

---

## 最终增量复审（2026-11-01 14:19，取代以上未关闭状态）

**本面全部已报告问题均已关闭，未发现当前增量引入的其它可证明 P0–P2 缺陷。**

已直接核对实际产品源码，未再运行前轮 proposed-only 脚本：

- `renderRuns`（`app.js:635–640`）在请求前记录 navigation 与递增 `runsRequest`，响应后同时验证 navigation、当前 tab 和当前 ticket，才更新列表。这覆盖离页迟到、先后请求逆序；不会把 Run 列表写回 Agent/审批等其它页面，也不会让旧 running 响应覆盖新终态列表。
- `syncRunFromRest`（`:2097–2108`）仍先校验当前 Run view 与详情请求 ticket，按权威 REST 更新弹窗，终态设置 finished 并关闭流；随后仅当前 runs 页刷新 `renderRuns`。没有调用会清 Run view 的 `renderCurrent`，原来的 SSE/REST 终态与断线恢复链继续有效。
- `openRun`（`:1651–1653`）在初始详情已终态时也刷新列表，不依赖终态事件再次回放。
- 新增 `run-list-sync.test.ts` 7 例对四种终态与取消按钮、非 Run 页、离页响应迟到、旧 running 响应晚到给出行为断言；删除终态刷新或任一关键响应保护会使对应断言失败。

本面独立重新执行 6 文件 **110 项测试，全部通过**（14:18:57）：`run-list-sync`、`app-run-sse`、`app-cancel-requested`、`app-auth-401`、`app-takeover-run`、`app-approval-resolved`。覆盖本次共享函数的终态、取消、鉴权过期、审批事件、流生命周期与迟到响应关联路径。Lead 回传全 console **586/586** 通过；此总量不是本面单独重跑的结果。

Lead 已回传最新真实浏览器证据：run2/run3 成功后，底层列表也为成功且取消按钮消失；版本选择及草稿保存不影响线上版本，已读回验证。该证据与当前修法和定向测试相符。本面始终未操作浏览器，不把自己的源码/Mock 测试记作浏览器验收。

**最终 Standards：通过（指定流程与回归面）。Spec：待验证（指定静态范围通过、无未关闭发现；完整 Web 验收以 Lead 汇总的真实页面证据为准）。运行时验收：本面未跑；Lead 已回传草稿/版本与终态列表的主流程通过。**

剩余范围说明：模型/Spec 编辑同步、凭据目录与其权限/异步、并发 Job/消息开发由其它审查面负责；真实待审批操作、完整导航尺寸、键盘/辅助技术等未由本面独立验收。没有提交、推送或部署声明。
