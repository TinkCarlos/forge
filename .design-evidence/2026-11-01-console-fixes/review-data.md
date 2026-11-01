# 单面审查：配置完整性、异步与权限

只读审查，未修改仓库、数据库或运行服务。范围固定为 `/tmp/forge-console-fixes-20261101/baseline/` 至本轮补丁，并结合截至本次检查的当前 `apps/console/public/app.js`；没有使用仓库整体工作区 diff。权威 Spec 为体验评审第四项和 `docs/02-architecture/admin-console.md` 的 2026-11-01 体验修复段。

**最终状态：本面发现全部关闭，未发现可证明的剩余缺陷。** 下文保留首次及中间复审证据；最终代码结论见末尾“最终摘要增量复审”。本面没有执行真实浏览器或持久化验收。

## 首次审查发现（当前状态见末尾增量复审）

### [P1，高置信度] 取消再恢复 MCP/OpenAPI 勾选会丢失已有工具白名单

`apps/console/public/app.js:1092–1094`：已有配置为 `{mcp:"erp",allow:["read"]}` 时，先取消勾选，当前实现删除完整工具组；再勾选时当前 Spec 中已不存在原组，只能生成 `{mcp:"erp"}`。OpenAPI 同样受影响。以真实 `chooseAgentCapability` 函数做 Node 自检，结果分别是 `off=[]`、`on=[{mcp:"erp"}]` 和 `on=[{openapi:"erp"}]`。这不是对象序列化差异：`packages/capabilities/src/index.ts:398–403`、`:420–425` 仅在 `allow` 存在时筛选工具；缺失意味着把整个目录的工具提供给 Agent。因此原来的只读或有限白名单会在一次常见的取消/恢复操作后扩大。

最小修法：在本表单内保留取消前的完整组并在恢复时原样恢复，或让带白名单的现有绑定只能在高级 JSON 中修改并清楚标注。不要为基础选择器放宽已有 `allow`。补充真实的 `checked=false → checked=true` 回归；当前测试只在原组仍存在时直接传 `checked=true`，无法捕捉此缺陷。

### [P2，高置信度] 异常 Spec 会令整个 Agent 详情不可打开

`apps/console/public/app.js:1463`：摘要直接对 `spec.skills` 调用 `.join`，对 `toolsets` 元素直接读取 `.builtin`。当前写契约仅要求 Spec 顶层是对象（`packages/contracts/src/route-schemas.ts:112,130`，`apps/api/src/plugins/http-helpers.ts:131`），既有数据或高级 JSON 可以包含 `skills:{}`、`toolsets:[null]`。以真实 `openAgentDetail` 方法和这两种 API 结果自检，均没有调用 `openModal`，只提示内部 TypeError，分别为 `(spec.skills ?? []).join is not a function` 和 `Cannot read properties of null (reading 'builtin')`。基线直接显示 JSON，因此此类配置原先仍能查看。

最小修法：摘要渲染先用 `Array.isArray` 和逐项对象检查；不支持的结构显示“请查看高级配置”，仍打开包含原始配置的详情。服务端 Schema 不必在本轮改变。补充异常结构仍可查看原始配置的回归。

### [P2，高置信度] 搜索隐藏已选资源后仍回显旧 ID

`apps/console/public/app.js:1142–1144`：`filter` 重建选项后恢复 `select.value`，但原选项不再匹配时，原 ID 不在新的 option 中，实际选择变为空；提示只在 `onchange` 更新，所以仍显示“选定对象 ID：旧ID”。典型路径：选择 MCP A，再输入不匹配 A 的搜索词。用户看到旧 ID 的确认文字，但保存会报“请选择组织或资源”。以真实 picker 和模拟原生 select 的定向自检复现 `selection=""`、`hint="选定对象 ID：mcp_…"`。此处是状态文案缺陷，提交端仍阻止空目标，没有证明错误目标写入。

最小修法：搜索过滤后按实际 `select.value` 更新提示，或在过滤列表中继续保留已选对象；补充搜索隐藏已选项的回归。真实浏览器行为由 Lead 复核。

## 已关闭的发现

最初 `secretResourceDirectories` 的 `api_app` 使用不存在的 `app.view`；实际 `/admin/api/apps` 要求 `apikey.view`，导致非通配权限用户错误进入手工 ID 回退。Lead 已修改为 `apikey.view`，当前源码 `app.js:1135` 与 API `apps/api/src/routes/admin/apps.ts:69` 一致；本项不再计为未解决发现。

## 查过的关键路径与证据

- 基础字段与高级 JSON：`agentSpecFields → editAgentSpec → bindAgentSpecEditor → openAgentCreate/openAgentNewVersion`；直接调用方只有两个 Agent 表单。已核对隐藏高级字段、未列出的 Skill/工具引用的克隆和保留行为。四项现有纯函数测试通过。
- 能力绑定：`chooseAgentCapability → raw Spec → POST Agent/version → agent_versions.spec_json → resolveTools`；运行时 `allow` 的确是工具枚举边界。
- 凭据作用域：`openSecretCreate → bindSecretScopePicker → 当前目录 API → POST /secrets → validateSecretScope`。作用域请求仍发送平台/组织/资源的原契约；目录名称和 Key 只用于显示/搜索，保存使用真实 ID；手工回退仍经服务端精确作用域检查，未见本轮扩大服务端使用范围。
- 目录读取：核对 `agent.view/model.view/mcp.view/tool.view/apikey.view/org.view` 与现有读 API；消息渠道仅核对本轮目录入口的权限一致性，没有延伸审查并发消息模块。
- 异步：`bindAgentSpecEditor` 在目录返回后重新读取当前 JSON，并以原 textarea 的 `isConnected` 防止旧表单覆盖新表单；`bindSecretScopePicker` 同时使用请求代次和原 select 的 `isConnected`。用真实 picker 的定向 mock 验证先 Agent、再切 MCP、MCP 先返回、Agent 晚返回，晚到 Agent 没有覆盖当前 MCP 目录。
- 错误/空态：目录拒绝会显示错误文字，空目录显示可创建或手工 ID 回退；类型切换会清空旧选择、搜索和手工 ID。重试也会清空当前手工 ID/选择，记录为当前交互行为，没有将其列为独立阻塞发现。
- 摘要：直接读取当前 Agent API 对象，草稿版本与线上版本分开标注，输出值经 `esc`；没有新增明文凭据读取入口或跨对象 API 查询。没有扩展到其它面的草稿/发布、运行布局和导航。

## 验证与结论

- 已执行：`pnpm --filter @forge/console test src/legacy/agent-spec-editor.test.ts`，4/4 通过。
- 已执行：提取真实函数/方法的 Node 自检，确认白名单取消/恢复缺陷、两种异常 Spec 的详情失败、晚到目录隔离与搜索提示不一致。
- 未执行：真实浏览器、实际目录响应、真实写入/读回、全仓测试或生产验收。Lead 报告的 569 项测试/typecheck 不替代本面所列失败条件，也不代表浏览器验收。

首次审查结论：Standards 不通过（已有工具白名单可被基础操作扩大）；Spec 不通过（配置保留和准确目标回显有缺口）；运行时验收未跑。当前状态以下方增量复审为准。

未审 Agent 草稿/发布流程、Run/审批/导航和并发 Job/消息实现；没有操作浏览器、启动服务或写数据库。

## 增量复审（2026-11-01）

Lead 修复后重新检查当前源码，原 P1、搜索提示 P2 和 API App 目录权限缺陷已关闭。原摘要 P2 的 `skills:{}` 和 `toolsets:[null]` 反例已关闭，但同一缺陷类别仍有对象元素/对象字段残留。

### 第二次审查残留（最终已关闭）：[P2，高置信度] 摘要类型守卫未覆盖元素和自由 Spec 值

`apps/console/public/app.js:1469–1471` 仅对数组容器及工具组作了检查，数组中的对象元素和 `mcp/model.provider/limits.maxSteps` 等值仍隐式转字符串。以下输入均符合当前顶层对象型 Spec 写契约，且提取真实 `openAgentDetail` 方法可稳定复现整个详情不打开、只 toast `Cannot convert object to primitive value`：

```json
{"skills":[{"toString":null}]}
{"toolsets":[{"builtin":[{"toString":null}]}]}
{"toolsets":[{"mcp":{"toString":null}}]}
{"model":{"provider":{"toString":null},"model":"m1"}}
{"limits":{"maxSteps":{"toString":null}}}
```

普通对象则可能被显示成 `[object Object]`。这与最初摘要缺陷是同一根因；不单列为五个发现。最小完整修法是对摘要中自由 Spec 的字符串、数字、字符串数组按预期类型格式化，异常值显示“请查看高级配置”，始终保留原始 JSON。无需更改服务端契约。

已保存自检脚本：[review-data-selfcheck.mjs](review-data-selfcheck.mjs)。执行 `node /tmp/forge-console-fixes-20261101/review-data-selfcheck.mjs`，该次复审 14 项中 9 项通过、5 项失败；五项失败全部对应上述同一摘要 P2。脚本只提取本轮真实源码函数，用模拟 DOM/API 验证，不操作浏览器、服务或数据库。最终修复后的结果见下节。

白名单恢复新增的实际 binder 检查通过：MCP/OpenAPI 同 Key 多组 `allow` 与额外字段完整恢复；连续两次取消/恢复不改变限制；高级 JSON 更新白名单后，再取消/恢复使用新值；目录晚到读取最新 JSON，不覆盖编辑内容。没有发现新增恢复逻辑可证明的同类遗漏。

作用域增量检查通过：旧 Agent 目录晚到不覆盖当前 MCP；搜索隐藏选中项后提示不再保留旧 ID；仅 `apikey.view` 可以请求 API App 目录；目录拒绝或网络失败保留手工 ID 回退并显示原因。

另执行 `pnpm --filter @forge/console test src/legacy/agent-spec-editor.test.ts src/legacy/agent-draft-workflow.test.ts`，9/9 通过。

第二次审查结论：Standards 在本面未发现新的权限/工具范围缺陷；Spec 不通过（当时摘要异常值恢复仍有同类遗漏）；运行时验收未跑。最终状态见下节。

## 最终摘要增量复审（2026-11-01）

本次只复审 `agentReadableConfig`、其唯一详情调用方和新增摘要回归；作用域与白名单没有再次修改，沿用前述有效证据。没有扩展到其它模块。

`apps/console/public/app.js:1073–1086` 的统一函数对字符串数组逐项检查；模型标识仅在两项都为字符串时格式化；工具组和工具标识分别检查对象/字符串；预算值只接受数字或缺省。详情 `:1488–1492` 使用其返回的安全字符串，并保留高级原始 JSON。原先五组对象反例以及对象型步骤/成本值均回退“请查看高级配置”，不会再隐式转换对象；正常摘要输出和输入对象不变。

本次执行：

- `pnpm --filter @forge/console test src/legacy/agent-draft-workflow.test.ts`，8/8 通过，包含新增五组对象反例和原异常结构回归。
- 提取最终 `agentReadableConfig` 做 Node 定向自检：六组对象值安全回退，以及正常模型/工具/预算输出和输入不变，全部通过。
- Lead 在最终源码执行已保存的自检脚本，14/14 通过；并报告控制台 54 个文件、586 项测试通过。本面未重跑其全量测试，未把该报告当作浏览器验收。

**最终发现：无。此前 P1 白名单恢复、P2 摘要容错、P2 搜索提示和 API App 目录权限缺陷全部关闭。** Standards：通过（限定本面代码审查）；Spec：待验证（静态覆盖通过，真实页面及持久化读回由 Lead 验收）；运行时验收：未跑（本面）。没有操作浏览器、启动服务、改产品源码或写数据库。
