# Forge 补充功能开发进度

日期：2026-10-31；代码基线：3cde87d；本地未提交增量。当前状态：实施中。

本记录承接[完整补充方案](2026-10-31-forge-completion-plan.md)、[224项覆盖矩阵](2026-10-31-forge-requirement-matrix.md)、[E0证据](2026-10-31-forge-e0-admission.md)。全部原需求与已确认决定保持不变；一个增量通过不表示全项目完成。

## 进度

| 范围 | 状态 | 实现/证据与下一步 |
| --- | --- | --- |
| E0 技术准入 | scoped READY | 见E0证据；Pi机制与内部Connector制品已核实；Linux目标部署尚待实际服务器验收 |
| E1 / FR-OP-02 / A01–A03 API Key生命周期 | 完成（LOCALLY VERIFIED） | 有效期、吊销、重叠轮换、同事务审计/幂等、权限标志与控制台入口；五端点DTO/OpenAPI。下方CASE及完整回归、浏览器主流程、两面审查通过 |
| E1 / 统一错误注册与HTTP边界 | 完成（LOCALLY VERIFIED） | 结构化ForgeError、remedy、编译期code约束、脱敏/日志边界、生成文档与verify检查；FR-DLV-03/FR-OB-01整体仍有后续项 |
| E1 / 配置revision与Schema基线 | 完成（LOCALLY VERIFIED） | 18表009迁移、17个配置写入口、If-Match/事务审计/内部写者/控制台；真实MySQL全量与双页冲突恢复通过，见下方证据 |
| E1 / Secret库与现有消费者 | 完成（LOCALLY VERIFIED） | 三类作用域、信封加密/keyring、版本/绑定/管理页、010迁移与独立回填/重包裹，完整证据见下文 |
| E1其余：完整contracts/OpenAPI/SDK、权限策略、快照、Thread/文件元数据 | 未开始 | 保留主方案全部范围；现有输入Schema已迁入contracts，局部响应契约不代表完整通用契约系统完成 |
| E2 Pi/Skill、Agent完整功能 | 未开始 | 按既定Pi适配与审批恢复方案实施 |
| E3 原生Linux执行器/会话文件/制品 | 未开始 | 专用执行服务器、独立UID/systemd；全网可访问；会话保留文件、空闲回收计算 |
| E4 Connector适配/模型/插件/开放平台剩余能力 | 未开始 | 使用已校验的内部0.2.0制品 |
| E5 Temporal/Redis/定时任务 | 未开始 | 不能把当前MySQL队列标作Temporal实现 |
| E6完整P0/UI/运维、E7 P1、E8 P2 | 未开始 | 保留覆盖矩阵；P1/P2尚需细化对应开发规格 |

## FR-OP-02 验证依据

测试数据只位于新建本机 MySQL 8.4.13 `forge_e1_20261031_test`，从空库执行001–008并使用现有seed和自动化fixture；未使用/重置日常`forge`库，无真实外部调用。它证明本地技术行为，不能替代公司目标环境/真实用户业务验收。

| CASE | 验收目标 | 实现/自动化 |
| --- | --- | --- |
| KEY-01 | 名称/有效期创建、哈希存储、仅一次明文、元数据列表、最后使用 | `tests/api-key-lifecycle.test.ts` |
| KEY-02 | 非法/无时区/非法日期/过去时间、到期边界 | 同上 |
| KEY-03 | 即时吊销、重复吊销、到期/吊销后轮换拒绝 | 同上 |
| KEY-04 | 三请求并发重试仅一把Key、仅一次明文、参数冲突、元数据重放 | 同上 |
| KEY-05 | 重叠期、继承Scope/有效期、旧Key到期后新Key仍可用 | 同上；既有Scope交集回归 |
| KEY-06 | 创建/轮换/吊销审计失败整笔回滚并可重试 | 同上（故障注入） |
| KEY-07 | 未登录/无权限/跨组织/CSRF/未知资源/严格输入无副作用 | 同上；既有跨组织写入与路由Schema覆盖 |
| KEY-08 | 控制台创建表单、重试幂等、过期/只读状态、吊销刷新 | `apps/console/src/legacy/app-app-scopes.test.ts`；ego正常入口流程通过，见下方记录 |
| KEY-09 | 生成的OpenAPI与contracts一致、不将内部API承诺为外部SDK | `tests/api-key-contracts.test.ts`；管理API第18节 |

## 最终验证（本地未提交候选）

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | 166文件、2077项全部通过，真实MySQL；含集成/契约与共享审计回归 |
| `pnpm test:console` | 43文件、516项全部通过 |
| `pnpm typecheck` / `pnpm build` | 通过（均为服务端tsc检查） |
| `pnpm lint` | 通过；0 error，4条原有React Fast Refresh warning；本轮新增警告已修正 |
| `pnpm build:console` | 通过 |
| `pnpm smoke` | 通过：工具、审批、调度、开放API、幂等、Thread续接、权限、包安装、审计、SSE、过期租约恢复 |
| `pnpm smoke:sso` | 通过：本地Mock OIDC交换/角色映射、Connector Principal签名/主体映射；不等于真实公司联调 |
| 差异检查 | `git diff --check`通过；后端安全/事务、前端/契约两面复审无未关闭P0–P2 |

项目当前没有独立的 `test:integration` / `test:contract` script；上表`pnpm test`实际运行了真实MySQL集成与契约检查，未用不存在的命令冒充通过。完整回归首次运行期间候选仍在修正、隔离UI服务也占用同库连接，出现契约/基线和连接统计失败；修正审计扫描/路由基线后停止同库服务，冻结服务端代码重跑，最终2077项全部通过。

浏览器证据：ego lite space22，从`/`本地测试登录→开放平台→表单创建应用/带有效期Key（真实鉴权200）→列表轮换（旧401、新200）→关闭后明文清除→列表吊销（新401）→刷新/重访读回两把Key均revoked且无写操作。检查桌面与390px视口；移动端初次发现名称逐字换行，增加局部列最小宽度后在最终候选读回测得104px并桌面复验，最终移动视口截图未重拍。截图仅包含测试前缀与元数据：`/private/tmp/forge-e1-key-list-desktop.png`、`/private/tmp/forge-e1-key-list-desktop-final.png`、初次移动截图`/private/tmp/forge-e1-key-list-mobile.png`；不含密钥明文。

审查闭环：发现并修复不同Key轮换的InnoDB间隙锁死锁（独立探针修后5×10=50/50成功，并新增自动化）、请求迟到覆盖表单（pending禁止关闭/Esc/重复提交）、元数据重放无法定位新Key（显示Prefix）、读取接口契约缺失。浏览器发现legacy没有`can`函数，已改由API返回实际权限标志并新增真实响应契约断言。

冒烟使用另一新建库`forge_e1_20261031_smoke_test`，避免影响完整测试的连接统计。临时3197 API与8090 Mock已停止，浏览器任务空间已关闭，临时明文测试Key文件已删除；两份测试库保留供复查。未改日常业务库；未提交、推送、部署或生产验收。

复现：为本机独立`*_test`库设置`TEST_DATABASE_URL`，先`pnpm db:migrate`/`pnpm db:seed`（DATABASE_URL同库），再`pnpm test`、`pnpm test:console`、`pnpm typecheck`、`pnpm lint`、`pnpm build:console`。密钥契约产物：`node --import tsx scripts/generate-api-key-openapi.ts`。

已用Skill：develop-closed-loop（开发）、test-case（技术验证规则）、code-review-multiagent（后端安全/事务、前端/契约两面审查）、ego-browser（真实页面验收）。没有提交、推送或生产部署。

## E1 统一错误体系（已本地验证）

关联：W01 §4.1、FR-DLV-03、FR-OB-01；不表示整个契约系统或可观测模块完成。

已实现：纯模块错误码注册表与封闭ErrorCode、结构化ForgeError/cause、所有现有构造调用迁移、域内显式异常归一、默认恢复建议、API错误DTO/Schema、边界脱敏与统一响应、生成文档与verify同步检查。原有HTTP状态/重试行为显式保留；已有Node网络回调仍使用标准网络错误协议，由上层边界转换。

CASE：ERR-01元数据/生产code引用/不可变检查；ERR-02未知code编译失败与运行时失败关闭；ERR-03私有cause/非法状态；ERR-04实际API错误DTO与恢复建议/脱敏/日志一次；ERR-05原有SSO/入参/权限/未知路由/租约行为回归。首批定向9文件75项和另一组5文件51项通过（有交集，不合计为独立用例数）；最终回归/审查待完成。

当前目标依旧为完整框架全部剩余功能；前轮已完成API Key，新推进错误体系。revision、Secret、权限策略、快照、Thread/文件元数据及E2–E8仍保留未完成，不因当前测试绿灯关闭。

错误体系审查已定位并修正：OIDC JSON客户端重复日志；新边界日志裸sk/ghp/JWT/fsk凭据漏遮；JSON引号凭据与URL userinfo的message/details漏遮。先补失败用例（6项红灯，其中HTML相关还暴露缺失的X-Request-Id响应头），再合并纯字符串规则、保留既有[REDACTED]格式、5xx固定注册表消息，MCP上游完整错误载荷只进入私有cause。新增真实HTTP回归和原有脱敏/SSO回归61项通过；完整回归待最终候选重跑。内部LeaseLostError仍作控制信号保留，标准Node回调错误继续按协议使用，并非所有Error子类都被替换。

### 错误增量最终证据

- 服务端全量169文件、2086项通过。此后仅为客户端模块边界等价拆出ID生成器；最终候选相关6文件76项通过、控制台43文件516项通过。
- `pnpm typecheck`、`pnpm build`、`pnpm lint`、`pnpm build:console`、`pnpm errors:check`通过；Lint仍只有4条原有Fast Refresh warning。
- 最新代码重启于独立3197端口/独立smoke库，`pnpm smoke`和`pnpm smoke:sso`通过；没有真实公司SSO或外部模型调用。
- 审查关闭原P1/P2：HTTP边界与公共日志规则、SSO JSON/HTML记录一次、cause不对外、reqId关联。core调用参数迁移及最终ID模块拆分已独立复审通过。
- ID生成器从共享ids常量模块移到id-generator.ts，core根导出不变，函数逻辑不变；前端守卫未放宽，并删除旧ulid副作用特殊处理。控制台产物继续只含获准共享常量。
- 新增统一错误是后端行为增量，没有新增界面/页面，本次未单独重跑浏览器。完整OpenAPI/SDK、全量可观测Trace、完整流水线与其余功能仍未完成。

下一执行点：E1配置revision与If-Match（428/409、保留编辑草稿）、Drizzle schema/迁移一致性，然后Secret/策略/Run快照和Thread元数据。所有E2–E8需求继续保持原范围；本目标仍active。

## E1 配置并发编辑与Drizzle基线（已本地验证）

规格：[revision设计](2026-10-31-forge-revision-design.md)，W01 §4.1 / C14。配置版本、公开前提及调用方一起迁移，未保留无锁用户写入口。18个配置表加revision、17类现存配置写入口强If-Match（新角色code创建除外）；新增428 CFG-8505。Agent/Skill子版本绑定、配置变更与审计同事务；MCP异步发现提交再CAS，普通创建/插件创建期间被编辑也不覆盖新源。内部SSO/seed/自动停用使旧表单失效，运行时钟不增加revision，旧tick不覆盖新配置。

Schema：Drizzle ORM 0.45.4 / Kit 0.31.11，34张现存表基线；修正导入遗漏的ASCII排序规则、DATETIME ON UPDATE和空默认值。0000仅差分参考，0001生成SQL由现有唯一迁移器作为009执行；命名锁、缺列恢复、不兼容列拒绝。实际MySQL列/外键/索引对比通过，`pnpm db:generate`无变更；没有迁移Repository查询到ORM，也没有另建迁移历史。

CASE/证据：`tests/configuration-revision.test.ts`29项，`tests/configuration-migration.test.ts`5项，契约产物2项（沿用api-key-contracts测试文件）。覆盖完整配置写入口、缺失/格式/越界、401/403/404/400优先级、并发仅一提交/一审计、审计失败回滚子版本、发布重放、MCP刷新/创建/插件发现期间的编辑、所有普通配置成功读写、角色映射并发/冲突、后台时钟与停用、UINT上限、空库/008升级/部分DDL重跑/重复迁移/异常列拒绝、二次seed失效旧版本。技术fixture位于本机独立*_test库，不冒充公司目标数据验收。

最终候选：服务端171文件2121项通过；控制台43文件516项通过；服务端与控制台类型检查、Lint、前端构建、errors:check、diff检查通过。Lint仅4条原有Fast Refresh warning。smoke与Mock SSO/Connector smoke均通过。独立数据库/并发审查及API/控制台契约审查发现的问题已修复并复审关闭；未发现未关闭P0–P2。

浏览器ego space23正常登录：应用创建→双页并发（第二页成功，第一页409保持完整草稿）→关闭刷新比较→重新编辑成功→刷新读回；Skill创建→修改名称及内容→元数据+版本连续保存→重访读回新内容。桌面与390px表单已截图视检：`/private/tmp/forge-revision-conflict-desktop.png`、`/private/tmp/forge-revision-form-mobile.png`。React API开关成功；通过另一页面API安排并发编辑后确认操作409，确认框/错误提示保留，已截图视检`/private/tmp/forge-revision-react-conflict.png`。通过管理API准备真实draft fixture，再从React列表发布确认并刷新读回新线上版本（技能/草稿的fixture内容均无真实业务数据）。未执行公司SSO/目标Linux部署。

本增量只关闭revision/Schema及其必要契约。Secret版本/轮换、权限矩阵、Run依赖快照、Thread/文件元数据、Pi/原生Linux执行器、Temporal/Redis、完整模型/插件/运维及E7/E8仍未完成，完整目标继续active。下一执行点：Secret/密钥版本与作用域，再按原依赖推进策略/快照/Thread；不将当前测试通过写成完整框架交付。

补充浏览器发现：React详情缺少publishedVersion导致合并快照后确认框误示“没有线上版本”；先以真实HTTP断言复现null红灯，再使详情按自身published_version_id解析版本。独立复审通过，重启后React确认显示正确的“当前线上版本是v1.0.1031”，发布v1.0.1032并刷新读回成功；API开关恢复关闭。最终服务端全量再次通过，UI验收期间未改动日常业务库。


## E1 凭据库与现有消费者（已本地验证）

规格：[Secret设计](2026-10-31-forge-secret-design.md)；用户确认平台/组织/指定资源，org精确本组织、resource精确类型/ID。已完成信封加密/AAD、私有keyring热替换、值轮换/启停/软删/引用保护、只写值管理API/DTO/OpenAPI/页面、现有Provider/MCP发现与调用/OpenAPI/Webhook五条取用链路。无正常管理入口再写v1或非空Header明文；Agent执行器中的Secret消费者仍随E2/E3接入。

010三表及5引用列，37表Drizzle；009历史清单固定。回填逐行保留坏数据、覆盖软删MCP、重复changed0；历史DEK重包裹不改数据密文/值/Secret revision。旧key最终退役须排空全部在途写者再统计，并保留备份恢复材料。运维文档：[secrets.md](../docs/06-operations/secrets.md)。

最终当前候选：服务端177文件2168项、控制台44文件521项全部通过；服务端/前端构建、类型、Lint（4条原有Fast Refresh warning）、errors:check、diff检查通过；最新服务重启后smoke与Mock SSO/Connector smoke通过。独立MySQL CLI演练及迁移形状反例、并发/作用域/撤销、真实本地HTTP与SSE回显验证均通过。两面独立审查发现已修复并复审；详细CASE、早期失败及最终日志/图片集中在[本批证据](evidence/secret-vault/README.md)。

ego space24正常入口：四类资源绑定既有Secret共5引用；只改名不清凭据；值关闭清空；双页409保草稿；轮换/历史/启停重访；引用删除409，无引用删除成功；React侧栏进入凭据。1800/390/768px及Tab/Escape检查；修正手机逐字换行和重绘后焦点丢失。原生200%/跨浏览器/axe未跑，不冒充通过。临时3197 API和8090 Mock已停止，space24已关闭；测试库保留，日常forge库未改，未提交/推送/生产部署。

## 2026-10-31 23:33 新增范围与决定

用户进一步要求：操作日志；统一账号、功能权限、数据权限和组织部门管理；生产SSO与完整本地登录/登出并行；账号新增/修改/删除/设置管理员；后台配置三方API即可使用；核对并补齐Agent/Skill/MCP编辑与启停、Agent关联模型/MCP/Skill/三方API；企业微信群Webhook及按成员ID/手机号@。

已回答：生产双通道登录；删除后用户名/邮箱可重用，新账号不继承旧ID数据/权限且保留日志、旧会话立即失效；完成/失败/待审批三类均默认群通知；SSO与本地账号只有管理员明确绑定后共用，保留本地权限配置，不再邮箱自动合并/SSO覆盖。旧“生产仅应急本地”规则由此用户决定替代，验签/audience/issuer/CSRF和本地数据权限边界继续保留。

自动Goal已由用户清除；当前按对话继续新增需求工作，未建立新自动Goal。新需求记录见`20261031-233358-账号权限三方API与群通知-详细需求文档.md`（READY FOR DESIGN，D01–D04已确认）。之前完整框架其余E1–E8范围没有被本批Secret通过或新优先级隐去；下一执行点优先统一身份/RBAC/数据策略与组织，并保留三方API、Agent能力配置、WeCom通知明确承诺。

## 2026-11-01 账号生命周期与操作日志（已本地验证）

用户D01–D04按[账号设计](2026-11-01-forge-identity-design.md)落地：生产双渠道、管理员显式issuer/sub绑定并保留本地授权；完整账号资料/部门/状态/管理员、改密/重置/删除重用/会话撤销与最后可登录管理员并发保护。seed改按不可变bootstrap ID仅首次创建，重seed不按邮箱提权或覆盖账号。登录别名歧义失败关闭、密码原值与严格hash、HMAC/MySQL节流、旧核验与排队账号写失效。

011/Drizzle0003：auth_login_limits、users.idp_issuer及binary主体、audit actor_name/outcome/索引，38表；升级/空库/部分DDL组合/重复/异常形状、列外键索引一致性通过。操作日志加入检索/游标/详情、历史操作者名称快照、安全前后值、失败/拒绝同动作码和组织归属。账号详情可按目标/操作者查看日志。

管理与开放SSE每500ms串行重查当前会话/Principal或Key/App/scope/Run范围，撤销后下一轮结束连接；不重计请求额度，不承诺撤回在途已授权批次。客户端退出关闭流。

最终：服务端182文件2192项、控制台45文件528项通过；服务端/前端构建、类型、Lint（4条旧Fast Refresh warning）、errors:check、diff、38表Drizzle无差异通过。最新API重启后smoke、Mock SSO/Connector smoke通过。两面只读审查发现及最后SSE增量已修复/回归/复审关闭，无本增量未关闭P0–P2。证据与精确CASE：[identity证据](evidence/identity/README.md)。

真实ego space25正常入口覆盖账号创建/改名/部门空值读回、设/取消管理员、SSO绑定、双页409保草稿、重置/本人改密/字段错误/退出、停用启用/撤会话、删除同标识重建新ID且无SSO继承、详情到日志、390布局横滚与关闭清密码、自降权跳有权页面/由另一管理员恢复。只使用本机技术fixture，不把Mock当公司验收。

当前自动Goal仍为用户已清除状态，未新建。原框架E1–E8未完成清单保留；本轮U01/U02及U05现存管理入口增量本地通过，后续角色/策略/API/通知新增动作仍须同步日志。U03功能权限、U04数据策略/组织树、U06三方API、U07能力可视配置和生命周期、U08WeCom均未开始实现，接下来先完成U03/U04的可实施设计与实现。未提交、推送或部署；真实SSO/企业群与Linux目标环境未验。

## U03 全局角色（2026-11-01）

普通任务授权继续，自动Goal仍为用户已清除状态，未新建。规格[全局角色设计](2026-11-01-forge-roles-design.md)，[证据](evidence/roles/README.md)。全局角色、矩阵编辑、复制/内置恢复/启停/引用删除、用户/服务账号附加角色、实时SQL权限、SSO初始化授权栅栏和正常控制台入口已落地。组织/组作用域绑定仍保留在U03/U04，未开放无效配置。

前一冻结候选：服务端184文件2209项、控制台47文件540项；构建/类型/Lint（4条旧warning）/Drizzle42表无差异/错误产物/Mock端到端及SSO Connector冒烟均通过。两面只读审查闭合权限上限、停用高权接管、SSO映射保护/JIT竞争、首发及包安装发布旁路、动态权限组合、登录落地和迟到导航/详情等发现。包安装现在按既有规范只生成Agent草稿，发布单独授权。

浏览器：原space25已不存在，经用户明确批准新建space29，p1管理员127.0.0.1、p2普通账号localhost Cookie隔离。创建/编辑/多角色绑定/有效预览、Role-only从React登录进入获准legacy页、停用403/恢复、复制、双页409保草稿、引用删除保护/解绑删除、长名称与390px布局通过。普通行高从操作换行撑大修为62.5px，表宽806在356容器内滚动；页宽390。原3张误名mobile图已更名desktop，实际模拟布局截图由CDP重设390后测量确认；未声称真手机操作。源测试角色与副本已清理，原账号恢复user/self后刷新显示仅“试运行/详情”，无创建动作。p3并发页已关闭，space29保留供后续完整任务。

最后自查新增边界修复：self范围user.manage改本人资料不再因部门未变化而403；创建/真正换部门仍校验可写且active，角色/数据上限及目标可见性保持。锁内用户/服务身份组织授权查询复用原transaction connection，避免满20连接时再向pool借连接。新增本人编辑/拒移部门升scope/跨用户404和占19连接enqueue探针，相关5文件86项通过；typecheck及权限面复审通过。该最后差异完整回归日志 `/private/tmp/forge-roles-all-accepted.txt` 正在运行，未把旧2209数冒充最新候选完成；最新本人编辑GUI在空间29执行中。

后续执行点：先完成此最后差异全量/本人与撤权GUI、更新roles证据/文件hash和计数，再接U04组织树CRUD及数据策略可实施设计。U06三方API目录、U07可视关联及完整生命周期、U08企业微信通知仍未实现，原E1剩余与E2–E8全部保留。未提交/推送/部署，无真实公司SSO/Connector、第三方业务API、企业群消息或Linux执行器验收。3198 smoke API与本轮8090 Mock已停止；3197 `_ux` API保持，日常库未改。


### U03 全局角色最终确认

最后本人编辑/连接池差异：服务端184文件2211项完整通过（`/private/tmp/forge-roles-all-accepted.txt`），控制台47文件540项证据仍适用（最后差异仅服务端）；typecheck、build、Lint0error/4原warning、diff通过。重启最新候选另做Mock端到端与SSO/Connector冒烟通过（roles-smoke-accepted / roles-sso-accepted日志）。最后权限面复审无未关闭本批P0–P2。

真实GUI self-manager仅本人1行、无新建入口，自己改名成功且刷新读回；随后管理员恢复原名称、user/self授权，测试角色清理，最终6内置角色；普通账号刷新仅有试运行/详情无创建。完整roles证据与candidate-files哈希已更新。全局角色增量LOCALLY VERIFIED；组织/组作用域、U04/U06/U07/U08及原框架E1–E8剩余范围仍未完成。下一开发点为U04组织树CRUD与完整策略设计，不把本轮角色验收当全框架完成。自动Goal未重建，无提交/推送/部署。
