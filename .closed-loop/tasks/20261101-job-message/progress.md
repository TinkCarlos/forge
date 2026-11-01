# Job与消息管理闭环进度

授权：按20261101-113405四份定稿文档开发、测试、修复与验收；不提交、推送或发布。完整范围保留，不以基础模块测试通过关闭用户功能。现有工作区747文件hash已保存在workspace-baseline.json，仅用于归属核对，不用于自动覆盖/回滚。

## 最新续作入口（2026-11-01 15:24）

当前仅本地候选，整体仍实施中。Job定义8管理API/SDK/配置页、消息24管理API/四页签/发送运行时、015消息表与016会话互斥/精确消息序号已实施；原生Job执行链和旧App一次切换尚未接通，不可把mysql-agent-bridge当成新native支持。最新后端198文件2314项、控制台56文件598项通过，typecheck/build/Lint通过（4条既有warning），独立复审已关闭本切片确认P0–P2。最新候选已通过并行Node24最终门禁，已收到归档清理完成通知，冻结已解除。

已验ego36正常入口与刷新读回：Job创建/发布/负责人/筛选，消息渠道/模板/规则固定版本/测试/补发/取消；本机WeCom技术请求1次及Webhook技术请求1次（独立HMAC校验通过），非真实群/业务验收。所有真实AC仍NOT RUN。后续必须按E1完整策略与快照→Pi/模型/执行器→Temporal/Job执行控制恢复→旧App/计划切换→人工/来源质量/产物/评测推进，范围不削减。

同一事件/渠道的模板已确认 Job→Agent→API应用→组织→全局，记录全部命中。消息UI保留另一任务实现，本任务做API/验收适配；保护其它任务空间和改动。测试仅显式两本任务库；现有库不reset，临时schema仅实际创建成功才清理。未提交/推送/发布，用户提供模型密钥未落盘/未调用。细节和历史失败见下文及[test-cases.md](test-cases.md)。

## 范围与状态

| 范围 | REQ | 状态 |
| --- | --- | --- |
| 输入契约/限额与确定性表达式 | JOB-01/02、MSG-02/03、L01–L08 | 实施中 |
| Job定义/发布/App授权/受理/API与UI | JOB-01、BASE-01 | 实施中 |
| 表结构/Drizzle/迁移/事务/旧计划桥接 | JOB-01、MSG-04 | 实施中 |
| 消息渠道/版本/Secret/规则/模板/发送与重放/UI | MSG-01～04 | 实施中 |
| 步骤/批量恢复/Temporal/业务锁/预算/执行器 | JOB-02/03 | 未开始 |
| 人工任务/来源/质量/产物/完整快照 | HUM/DATA/FILE/VER | 未开始 |
| 评测/运营/交付跟踪 | VER/OBS | 未开始 |
| 27项AC逐项验收、系统回归与最终审查 | 所有REQ/AC | 实施中 |

先完成纯契约边界及定向技术单测，再进入数据/服务/API/页面纵向切片。技术协议向量只用于局部测试，不冒充真实业务数据/UI验收。E1完整权限/快照、E2/E3执行器及E5 Temporal依赖仍按定稿顺序落实。

测试与证据见[test-cases.md](test-cases.md)。使用develop-closed-loop、test-case、ponytail full；每次后续交接先读本文件及定稿设计。不得创建日常入口替换、不得重置原工作区；运行代码变更在交付可运行服务时重建/重启隔离实例验证。


## 当前开发记录（2026-11-01）

本会话开始时另外记录749文件hash到session-baseline-20261101.json；原747文件workspace-baseline保留。没有reset/checkout/提交/推送/发布。

已写入的基础实现：
- contracts/job-messaging、job-definitions、job-graph、job-json、message-config：精确限额/Unicode/金额/未知字段/字段条件；PATCH省略不补默认；有界映射/条件和依赖/回环检查；迭代JSON验证及规范序列化；模板变量/提醒注入和Secret UTF-8边界。
- core：完整ULID newId、集中17项权限目录（旧非管理员角色不自动追加）、18个注册错误；统一QueryFilter数据结构。
- store：013目录刷新、014 Job基础8表及Drizzle/DDL/冻结元数据；READ COMMITTED可选事务；Job定义/编辑/发布/引用保护/App授权/同连接原子受理；SQL allow-minus-deny交上限、NULL匹配按FALSE；签名筛选绑定分页。受理实时授权callback必须由后续governance服务提供，不是已实现完整E1策略解析。
- runtime/job-expressions及message-protocol：确定性求值、精确Webhook签名、企业微信受控模板/成员与字节校验、按协议区分成功/失败/未知/有限重试。未接入派发器，未向真实接收端发送。

已定位并修复：Zod带refinement对象partial导入崩溃、PATCH默认值误覆盖、深层JSON递归溢出、Secret计量单位、bootstrap重复索引/FK、NULL deny误排除、持久业务去重被新版本/停用状态阻断。反例测试保留；分面审查只读，无无关工作区重写。

当前验证：定向契约/表达式/消息协议/真实MySQL受理/迁移/角色回归已执行；最新完整系统回归仍执行中。证据在quality-reports；不得用这些局部检查关闭27项业务AC。独立库forge_job_message_20261101_test及独立smoke库；日常forge与生产未迁移。MySQL8.4.13、Node22.23.3，未验证MySQL8.0.30/Node24。

用户已提供测试模型配置，允许本任务受控验证；秘密未写入源码、进度、文档或日志。模型尚未调用。四项目真实样本、Linux执行器、消息接收端尚未指定；真实付费调用/群通知/生产写边界沿原授权，不把fixture当真实业务验收。

## 下一步（完整范围仍保留）

1. 关闭本批审查与系统回归失败；补齐新增公开Store方法定向验证。此后再进入可用入口，不能将Store基础当成A1完成。
2. E1完整策略加载/权限上限与快照 → A1领域服务、管理/Open/集成API/生成OpenAPI与SDK/React入口及旧计划桥接。
3. A2渠道不可变Secret版本/规则/模板/发送attempt账本/出站策略与配额；旧App回调一次切换/回填/兼容CAS；管理API与React页面。
4. E2/E3/E5与B恢复/人工/资源锁/费用账本；C来源质量/文件编辑保护/产物；D评测/运营与交付。
5. 获取指定真实样本与Linux/接收端后，从正常入口逐项执行27项AC，集成验收与最终范围审查。没有当前授权不得提交、推送或发布。


## 测试隔离事件与回归记录

第一次smoke:isolated调用漏传FORGE_SMOKE_DB，脚本按独立默认值重置/使用了forge_test，原测试数据未预先备份，无法确认恢复；不是专属库验证，也未改日常forge。已向用户明确报告。此后显式FORGE_SMOKE_DB=forge_job_message_smoke_20261101_test，专属库端到端通过。禁止把前次调用写成“所有测试仅专属库”。

首次完整系统回归189文件2246项：187文件2242项通过，4项OpenAPI产物同步失败；已同步5份生成产物，失败项与新增方法6文件40项回归通过。新增4项存储用例后最终完整回归执行中，以system-tests-final.log为准。

控制台50文件556项、build:console/typecheck:console通过；服务端typecheck/build、errors:check通过；Lint0错误/4条既有warning。显式专属库smoke通过；Mock SSO首次因回环保护拒绝，使用本次临时OUTBOUND_ALLOWLIST=127.0.0.1:8091后通过，未改变项目安全配置或生产开关。未提供的test:integration/test:contract脚本没有假称已运行，集成/契约测试包含在真实MySQL Vitest套件中。

审查：code-review-multiagent两面只读复核；契约/PATCH/JSON/字节、SQL NULL/持久去重、元数据迁移等发现均已修并有回归。当前本批未留已证实P0–P2，未覆盖的功能仍按上述完整列表保持未完成。


## 本批最终证据与停点（2026-11-01 13:05 北京时间）

完整系统回归system-tests-final.log：189文件2257项通过；随后仅补渠道URL格式边界与“已发布身份字段原值可保存”的定向修正/用例，最终7文件51项通过（final-focused-tests.log），当前类型检查与Lint再次通过。未把后补1项算进旧2257总数。控制台50文件556项/build/typecheck证据仍对应未改的控制台；错误产物同步与专属库smoke/Mock SSO通过，diff --check通过。

新Root、Store、Runtime、contracts和迁移面已复核，未留下本批已证实P0–P2。主代理最后自查：发布后不可改的businessType/org只拒绝实际变化，保留完整表单原值保存；新增反例验证。消息重试入参已命名cycleAttempts，避免后续sender误用累计attempt_no导致人工补发立刻超次数。

新增基础表尚无生产业务消费者；当前只完成内部基础实现和技术验证，不能称A1/A2或任何整条REQ已完成/LOCALLY VERIFIED。27条业务AC全部NOT RUN。未实现部分按“下一步”原清单保留，不以缺少真实数据为理由省略尚未写的服务/API/UI代码。

本次自行启动的8090 Mock和smoke私有API/8091 Mock IdP均已停止；未替换日常入口，未创建镜像/容器，无本轮可清理旧镜像。专属测试库保留便于后续开发，forge_test误重置事实与恢复缺口如上。没有提交、推送、生产部署或真实模型/群消息调用。


## 续作进行中（2026-11-01）

用户再次明确：继续完整范围，测试显式本任务库，禁止重置已有库，不提交推送发布。本轮baseline为continuation-baseline.json；专用/tmp runner强制显式FORGE_TASK_TEST_DB只接受两个本任务库，拒绝reset和smoke:isolated指令，FORGE_ALLOW_RESET=false。未重置任何库。

新增：真实主体/活跃组织链与当前role/data_policies读取，SQL ceiling交集（QueryScope.intersection），事务内重读授权；完整E1自定义范围/组/直接授权仍未实现。Job定义8条管理API、配置ETag/规范校验/草稿权限投影/已安装Ajv2020 Schema发布校验、负责人引用校验、版本分页；typed SDK、OpenAPI初稿及React Job入口/筛选/分页/编辑/发布/版本。仍没有执行API和Job运行时或消息配置/发送路径，不能判整个REQ完成。

真实浏览器：ego space34「Forge Job 消息管理 20261101」，p1；独立API3291、本任务forge_job_message_20261101_test，EMBEDDED_WORKER=false。/tmp/forge-job-ui.json有本次技术fixture账号（0600，不输出密钥）；创建job-ui-20261101，已从登录/侧栏正常入口创建→保存→刷新读回→发布→刷新→版本详情。截图job-editor.png显示高级JSON撑高，已修Textarea固定可滚动高度，待最新build重新验收。API当前仍是旧进程，最新代码必须重启3291后再验收。日常入口未替换。

当前测试：新增API/路由/Schema43项通过；追加权限/引用/规范化等测试后最新job-api 6项通过，新增同$id合法Schema回归在跑；控制台51文件558项通过。最近静态/构建见continuation-typecheck与job-console-build。没有把旧完整2257计数当本轮最新全量。

只读两面审查修复：草稿必须同时拥有manage数据范围（批量SQL投影，allowedActions支持UI隐藏）；输入/输出Schema独立Ajv实例防相同$id误拒；Key先trim；负责人active/可见引用；缓存绑定身份权限范围，Job-only落地根路由，版本SDK/UI分页，对话框opener恢复，字段内联与渲染解除disabled后focus，发布后失效版本缓存。最后两处待最新浏览器/测试复核。组织/负责人表单、业务/组织筛选仍需补；完整API/Open/集成/执行/消息/恢复/人工/产物/评测/27项业务AC均未关闭。

## 消息纵向切片续作（2026-11-01 14:16，尚未整体完成）

用户实施确认：同一事件/渠道命中多规则，模板按 Job→Agent→API应用→组织→全局，记录全部命中和选中规则。已同步四份定稿及架构；须保留此决定，不再询问。原ego空间34消失后，用户明确允许重建；目前唯一专属空间36「Forge Job 消息验收 20261101续作」p1，用户空间1与另一任务35未操作。

已实现消息24个管理端路由（总路由141），渠道/模板/规则/发送记录四页签、纯类型SDK与messages.openapi.json；015迁移7表已在两专属库前向执行，日常forge未迁移。渠道地址版本专属不可变Secret，签名/Header当前Secret；保存不发，测试/补发/取消分别验证权限、CAS与资源级幂等。规则写锁eventType，检查100渠道/组织上限、范围/组织/模板资格；不可变模板发布。Run终态和审批事务冻结一致规则/渠道/模板到outbox，sender只用冻结快照；旧Webhook还未切换，不声称M04完成。

发送运行时已接worker：channel→delivery锁序，prepared/submitted派发点、epoch/fence/短租约、10秒safeFetch、Webhook签名/6次有限重试、WeCom业务返回/未知不自动重试、同目标20/分钟持久节流、取消在途回收真实事实、总尝试/新sendCycle/首次成功保留、过期发送者只更新历史证据。测试与直接Run/App Run资格有实时重验；Job来源尚未接通。

审查修复：Secret跨渠道统一顺序加锁；停用/再启用期间在途失败后不自动放行；未知/最终超时/取消后重复风险沿attempt历史保留；Run正文使用新deny过滤；App来源资格；幂等scope含资源并hash至既有64列；时间比较按毫秒；通知链接绝对真实旧Run入口；渲染失败正文禁止重发；tab参数不进入发送记录API；身份缓存、关联版本/选择项失效、模板父ID、关闭焦点、错误定位、空态、确认显示渠道名。最终复审仍待。

证据：message-complete-regression.log 4文件22项；message-route-contracts.log 3文件45项；首轮全量195文件2291项有7失败（HTTP大小/类型/DELETE闭合、审计分类、Secret生成物），已修并由message-structural-regression.log 6文件50项通过，当前版本全量待复跑。不得把旧全量当新代码全绿。测试显式FORGE_TASK_TEST_DB，禁reset/isolated，所有DB访问只两任务库；空库演练的临时库由测试自己新建/删除，不重置任何已有库。

真实UI技术fixture：API3291已重启当前候选（EMBEDDED_WORKER=false，OUTBOUND_ALLOWLIST仅127.0.0.1:3292）；本机技术接收器3292，message-ui-receiver.jsonl只留hash/技术标记，无秘密。正常登录→侧栏消息→创建message-ui-20261101→保存后刷新默认disabled/掩码/零发送→显式启用→明确渠道名测试→发送记录→手动本任务dispatcher发送给本机Mock→刷新delivered/attempt1/正文→成功补发先强制重复确认→受理cycle2→取消未派发→刷新已取消、首次成功与attempt1保留。截图message-delivery-ui.png已查看。此为真实框架UI+本机Mock技术验收，不是企业真实群/业务验收。模板/规则/移动视口/其余Job用户路径继续验收。

服务进程仅本任务：API exec session44021；本机接收器session19879。任务账号/tmp/forge-job-ui.json（0600）勿输出凭据。/tmp/forge-message-ui-dispatch.ts验证无其它待发/outbox后只发本任务技术渠道。下一步继续关闭页面和系统回归，再旧App切换/Job执行/Temporal/恢复/人工/文件质量/评测与27AC，不得提交推送发布，不得重置数据库。

14:35补记：消息版本/attempt分页已拆limit/cursor专用Schema；结构HTTP类型/Unicode原始边界显式但保持Zod语义Key trim。API重构时一次批量替换误把Zod对象传作query参数，API正常GET回归已截获，已修，最新12文件72项通过。新增来源Run deny正文红灯/修复回归、规则最具体优先与所有命中保留、跨渠道同幂等键合法、最终Webhook超时重复确认、21条WeCom节流、不合格来源在submit派发点二次拒绝。当前服务端typecheck通过；随后审计4文件28项通过， before/after仅安全指纹/版本，理由经API脱敏。尚需最新全量和最终复审。

模板真实UI：名称129码点返回内联错误，焦点message-name且aria-invalid=true；其它草稿保留；修正后保存→刷新→独立发布v1→启用→刷新→版本读回内容/Hash。规则正在全局范围+本技术渠道+固定模板v1验收。没有发送真实群消息；本机接收日志只有1条技术消息，补发已取消未再次发送。

## 14:57 依赖与跨任务协作更新

用户已明确：消息UI保留另一任务实现，本任务负责接口与验收适配。channels/templates/rules/configuration-fields/configuration-values及审计扫描AST修正属于并行任务，已保留；不得覆盖。ego36独立于另一任务35/38，只操作本任务对象。

016运行/会话兼容扩展本批已生成Drizzle 0007与meta、run-thread-shape.json、幂等迁移、bootstrap内联建表、数据文档、生产者/消费者及测试；当前配套文件齐全，非占位shape。两任务库已前向016，禁止reset。新admitRun在READ COMMITTED短事务内锁会话、校验主体/App/删除与旧活动Run，创建Run+首消息+首事件并更新active_run_id；终态只释放指向本Run的指针。消息新增thread_seq（DB计算，CAST字符串处理BIGINT精度）及协议标记，旧seq/正文保留、旧thread_seq为NULL，不推断旧App归属。旧worker领取普通/指定Run/取消/过期审批均限定mysql-legacy，尚未启用Pi/Temporal或标frozen。

run-thread-regression.log最新6文件30项通过，含真实MySQL并发受理、等待/终态指针、App/主体/删除隔离、BIGINT并发与失租回滚、历史消息/引擎、空库及升级/断点/重复迁移、错误列默认/索引拒绝。曾将DDL追加bootstrap尾部导致重复启动失败，已改内联建表并由该回归覆盖，未删减检查。typecheck通过，定向Lint0错误（测试目录本来不在eslint匹配内）。本批正在只读独立审查，未关闭完整E1或Job执行需求。

另一任务审计扫描器正确忽略TS参数类型后的定向测试已通过。先前message-system-final.log 196文件2300项中2299通过/1误报；尚未将其它会话的全绿计数当成本会话最新全量。API3291现已重启最新源码，EMBEDDED_WORKER=false，session43763；前端重新构建以保留并行UI实现，开始本任务页面复验。

15:06 稳定检查窗口：016修复BIGINT读取精度（repo读取均CAST字符串）、可核实历史App会话续聊（精确一致来源才绑定）及终态/已移交Run禁止追加消息。对应fixtures改为先写消息再终态，未放宽脱敏断言；lease-fence用例终态写放最后，所有fence写检查保留。sse-message-masking的newRun同样先写消息再应用目标状态。message-config识别官方WeCom域名时去尾点，正常/尾点等价机器人同一个20/分钟配额；冻结raw fingerprint仍各自保留。17项quota/sdk、214项Thread/旧权限/脱敏/lease/集成定向通过，最新SDK/Job/迁移21项通过。

为其它会话全仓门禁留验证窗口：当前backend/016/上述fixture配套文件已稳定，接下来本会话做浏览器验收及静态/全量，不再边运行全量边修改这些源码。前一次run-thread-system.log失败含old模块cache+新测试文件混合版本、build期间SPA短时503，不算当前候选全量；必须完整重跑。Job UI新增组织/负责人（user API的真实display_name）、业务/组织筛选及SDK筛选白名单，沿用其它任务onReject与配置编辑器，没有覆盖消息UI。前端build修正一个跨包type导入解析问题后重跑，待浏览器/系统验收。本记录不宣称Job运行时或完整E1已交付。

15:08 共享门禁窗口确认：本会话从15:06起不再修改应用/契约/测试/依赖/构建产物，等并行全仓Node24 verify:envs收尾；当前本会话也运行system-stable.log全量。组织/负责人/筛选代码已于窗口前落地，build通过，56文件598项控制台测试、typecheck和Lint通过（0错误，4条既有FastRefresh警告）。仅继续ego36正常UI验收、只读分析、/tmp候选补丁和进度留档。

只读复审的待修P2：定稿统一createdFrom含/createdBefore不含，消息实现现仅from/to且to包含边界。已核实，尚未修改工作树以保护上述门禁窗口。窗口结束后按权威字段接入（保留当前UI别名兼容，冲突参数拒绝）、严格上界和带时区校验；补精确时间边界/同义参数/SDK/OpenAPI回归。不得因门禁绿灯称此项已闭合。WeCom尾点域名helper已在本会话15:01修复，其17项定向通过，不需另行重复修改。

15:12 本会话稳定窗口证据：system-stable.log 198文件2309项通过；stable-console-tests.log 56文件598项通过；stable-typecheck/Lint/build及errors:check通过，Lint仅4条既有warning。Job三筛选从页面操作后刷新，URL和业务类型/状态/组织均保留；筛选Forge组织正确显示无匹配（原本任务配置org=NULL），回全部组织恢复本任务记录。Job已发布配置添加负责人“Job验收管理员”→保存→刷新→编辑读回，org字段disabled；窄屏job-ownership-mobile.png已查看。消息模板新UI390px截图已查看，变量按钮换行、预览与控件无横向溢出。

27业务AC继续NOT RUN，M04、完整E1策略/快照、Pi/执行器/Temporal/Job执行与恢复/人工/产物/评测仍未实现，不以当前全绿降格或排除。时间契约P2临时补丁已准备，等待并行Node24门禁窗口收尾后落地。另针对“禁止重置已有库”的严格约束，准备将4个迁移fixture的清理增加创建成功凭据，仅删除本测试实际新建的临时schema，防CREATE失败时清理同名既有库；尚未落工作树，不改变当前门禁候选。

15:14 Job UI只读复审另发现P2：未发布任务编辑时的“当前组织”哨兵与PATCH省略语义冲突（会保留旧组织）。修复已准备在/tmp，门禁窗口后仅创建显示current哨兵，编辑必须选择真实组织ID/null；不通过改PATCH语义影响旧客户端。待持久化回归后关闭。当前窗口源码保持不变。

15:17 门禁窗口结束：并行Node24原verify:envs的test/unset两模式PASS且0 skipped；development单独重跑的node24-development-final.log显示PASS（0 skipped，192s）。这是15:06稳定候选的跨会话证据，不冒充后续修复版本。已落时间半开区间/兼容别名/时区/游标规范化、SDK input类型、Job编辑去current哨兵、迁移临时库创建成功才清理补丁，并重新生成messages.openapi。正在重跑本会话最新定向与静态检查；本批还有SDK最小输入测试误省略Rule必填status，类型检查已截获，按既有RuleWrite补status，不改变合同。

15:20 当前候选再次冻结：收到并行门禁任务要求后，本会话保持应用/契约/测试/依赖/构建产物稳定，直到其明确通知“归档清理完成，可恢复写入”，不再按估计时长自行恢复。继续只读审查、ego36本任务隔离数据验收及临时补丁；本会话system-reviewed-final.log同时执行当前候选全量，不混改源文件。

本批定向：review-final-focused.log 9文件40项中39通过、1项SDK测试自身误省略RuleWrite必填status；按权威合同补回，review-final-sdk-api.log 4文件16项全部通过，包含规范字段/时区/半开时间窗/别名冲突/跨别名游标、SDK默认字段可省略及Rule必填字段保留。迁移4组其它用例原39已覆盖，未放宽。最新服务端typecheck、控制台build、Lint通过（0错误/4既有warning）。API3291已重启最新候选，PID96110/session85523；本机receiver3292重启仅技术HMAC校验，session88830。

Webhook真实技术UI：创建message-webhook-ui-20261101→保存刷新disabled/掩码/0引用→明确启用→明确渠道名测试受理01M6AZF5XT5GGA2T7C296A2903。第一次单独dispatcher漏临时OUTBOUND_ALLOWLIST，安全保护拦截，未达接收端；页面详情failed/attempt1→补发填写原因→cycle2→仅该进程允许127.0.0.1:3292→本机HTTP200，receiver独立按原始正文验证HMAC signatureValid=true，bodyHash与发送正文hash一致，status delivered/totalAttempts2。保存不发、失败事实保留、显式人工补发均未绕过；接收日志仅安全技术metadata，无秘密。此前WeCom本机技术请求1次；本次Webhook真实网络请求1次。不是企业真实群或业务客户验收。

15:22 当前新候选全量：system-reviewed-final.log 198文件2314项PASS、0失败/0跳过（188s），不再使用旧2309替代。独立两面复审已确认：终态/移交Run追加保护、旧App可核实来源适配、BIGINT repo读取、Job编辑org哨兵、Job/Message SDK z.input以及规范半开时间合同均闭合；未发现这些已实现切片新的可证明P0–P2。完整E1/E2/E3/E5等范围仍未实现，不能由本批审查关闭。并行门禁仍在对当前候选收尾，继续冻结源码。

15:23 安全/实图补证：git diff --check通过；限定任务代码/文档/日志未查到用户提供的模型网关域名/带访问路径引用，未持久化或调用提供的模型密钥。message-webhook-delivered.png已实际查看，HTTP200/轮次2/总尝试2/原失败attempt1完整可见；正文仅技术TEST。未替换日常入口、未发送真实群、未操作生产、未提交推送发布。并行Node24-handoff verify已到56文件598项控制台PASS；等待其归档/清理通知。

15:26 已冻结相关候选hash至current-candidate.json（含保留的共享UI，非作者归属/非工作区干净声明，禁止据此自动覆盖）。Job未发布配置技术对象job-ownership-ui-20261101已从正常页面选择Forge→保存刷新编辑读回Forge；再改未分配组织→保存刷新读回未分配组织。编辑下拉只有真实Forge/未分配组织，没有current哨兵，原问题已实际闭合；未发布未执行，无模型/外部业务副作用。


## 控制台后续全仓门禁收尾（2026-11-01 15:25，未提交/部署）

用户明确要求修复历史34条lint和25项后端失败，并授权跨会话协调。本轮保留并行实现，补齐Job原8处Promise错误处理、修审计扫描误认参数类型；与后台协作关闭会话夹具及机器人尾点域名限流回归。前一候选Node24三环境已通过，随后检测到新批次落盘，最新候选重新执行Node24完整pnpm verify：198文件2314项后端＋56文件598项控制台，0失败/0跳过；build、smoke、smoke:edit、Mock smoke:sso均通过。最新验证窗口源码指纹一致。4条既有Fast Refresh warning保留；独立integration/contract命令未配置，不伪称已跑。Job正常入口、保存/错误保留/发布/筛选、真实停服与恢复、消息四页签及最终构建读回有本轮独立证据。完整边界、两候选区别、原失败、原始日志与清理见[收尾记录](quality-reports/20261101-console-followup-gates/README.md)。没有重置已有库、提交推送或生产发布，原27AC和完整运行时等未交付范围保留。

## 15:29 本批收尾与下一依赖

已收到并行任务明确“归档清理完成，可恢复写入”通知，冻结解除。其最新Node24.22.1/MySQL8.4.13完整verify为198文件2314项后端+56文件598项控制台，0失败/0跳过；build/smoke/smoke:edit/Mock smoke:sso通过。已读取归档README核对，不把旧2309三环境矩阵当最新候选。归档时源码637个指纹一致，本任务73相关候选hash复核无变化；本批只读复审P0-P2均已关闭。当前仍仅本地候选，未提交/推送/发布。

保留本任务3291 API（session85523，EMBEDDED_WORKER=false）、3292技术receiver（session88830）、ego36 p1与两任务库，供后续推进和读回；不操作已结束的其它任务空间/数据库。没有创建容器或镜像，未清理其它资源。本批没有重置任何已有库；历史误重置事件及无法证明恢复的缺口继续保留上文，不抹去。

下一批按完整原范围推进E1：组/组织绑定、自定义数据范围/直接allow-deny、所有旧入口统一QueryFilter/实时上限及不可变Run依赖快照；再E2 Pi/E4模型预算及E3 Linux执行文件/对象存储；E5 Temporal后完成原生Job三入口、执行详情/步骤/attempt/控制/恢复/人工，配套旧App/计划唯一迁移；随后质量/产物/评测与27项真实业务AC。当前未实现清单不因本批绿色自动关闭，真实样本/Linux/真实接收端仍需既有授权资源条件。
