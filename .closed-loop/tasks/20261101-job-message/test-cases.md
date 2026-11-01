# 用例与证据

模式：closed_loop；本批仅规范定义的技术契约单元检查，不使用客户/生产数据，不调用模型/数据库/群机器人。

| CASE | 来源 | 断言 | 状态 |
| --- | --- | --- | --- |
| C01 | L01 | 中文/emoji按码点限制，Key与原因不接受非法边界 | PASS（局部单测） |
| C02 | L03–05 | 默认值正确；数字不强转；金额字符串精度与范围正确 | PASS（局部单测） |
| C03 | L02/JOB-01 | 1–1000项/重复明细键/64KiB；非JSON值拒绝、不得自报主体 | PASS（局部单测） |
| C04 | JOB-02 | 控制动作/原因/stepIds条件组合合法，未知字段拒绝 | PASS（局部单测） |
| C05 | MSG-03 | 重发明确重复/历史目标意图，拒绝URL/正文覆盖 | PASS（局部单测） |
| C06 | L06 | 自定义消息模板变量白名单与UTF-8 2048/2049边界 | PASS（局部单测） |

Job和消息管理用户入口、迁移/并发、真实MySQL、Temporal、浏览器与外部系统27项AC均NOT RUN。上述检查即使全部通过也不代表完成REQ或LOCALLY VERIFIED。


## 追加技术覆盖（不是业务验收）

- C07：定义默认与PATCH省略、显式授权目录/ULID、Secret UTF-8、渠道/订阅非法字段；tests/job-expression-contracts.test.ts。
- C08：missing/null/0/false、严格规范JSON、原型/通配引用拒绝、深层JSON和循环对象、回环/依赖合法性；同上。
- C09：真实MySQL Job CAS/不可变版本、SQL deny/NULL/上限、签名分页、6路并发仅一次入队/审计、缓存过期后的业务去重、不可见/撤权事务回滚和50队列上限；tests/job-admission.test.ts。
- C10：空库与012升级同形、部分DDL重跑、错误CHECK/索引/默认值拒绝及历史行保留；tests/job-core-migration.test.ts、configuration-migration.test.ts。
- C11：精确HMAC向量、受控变量/提醒注入、2048/2049字节、企业微信业务错误/非法响应/未知、Webhook至少一次、429/Retry-After/最大6次；tests/message-protocol.test.ts。没有真实发送，不覆盖持久投递/节流账本/停用竞态。

执行日志见quality-reports。旧角色回归、错误注册表和ID规范测试一并执行；全系统/前端/构建/Mock SSO与smoke结果以最新日志为准。

## 27项业务AC状态（全部保留）

| AC | 实施/证据缺口 | 当前状态 |
| --- | --- | --- |
| AC-J01 | 三种真实触发入口/统一身份配额 | NOT RUN |
| AC-J02 | HTTP入口响应丢失与业务回读（仅Store去重已测） | NOT RUN |
| AC-J03 | 报告页恢复/编辑保护 | NOT RUN |
| AC-J04 | 步骤账本/聚合与未知恢复 | NOT RUN |
| AC-J05 | 真实外部执行器回读/重启 | NOT RUN |
| AC-J06 | 真实暂停/取消/页面重访 | NOT RUN |
| AC-J07 | 真实worker失租/迟到回执 | NOT RUN |
| AC-J08 | 定时身份与资格撤回 | NOT RUN |
| AC-J09 | HTTP原始字节/批次边界且零副作用（局部Schema已测） | NOT RUN |
| AC-J10 | 自动尝试/3轮恢复账本 | NOT RUN |
| AC-J11 | 费用预占与并发许可 | NOT RUN |
| AC-M01 | 保存零发送/独立测试/只写Secret页面 | NOT RUN |
| AC-M02 | 可靠fanout与去重/嵌套范围 | NOT RUN |
| AC-M03 | 真实模拟接收端/投递账本（局部响应判定已测） | NOT RUN |
| AC-M04 | 未知/重发/重启账本 | NOT RUN |
| AC-M05 | 停用/版本变化/挂起与显式补发 | NOT RUN |
| AC-M06 | 旧App/投递迁移与唯一发送链 | NOT RUN |
| AC-M07 | 跨组织消息鉴权/审计 | NOT RUN |
| AC-M08 | 真实发送节流21条/字节边界（局部字节已测） | NOT RUN |
| AC-M09 | 提交派发后停用竞态 | NOT RUN |
| AC-M10 | Secret/旧目标/旧App CAS兼容 | NOT RUN |
| AC-H01 | 人工决定/版本冲突/继续执行 | NOT RUN |
| AC-D01 | 真实来源缺失/部分/零与门禁 | NOT RUN |
| AC-F01 | 编辑保护/归档/权限下载 | NOT RUN |
| AC-V01 | 完整冻结依赖/旧执行恢复与撤权 | NOT RUN |
| AC-O01 | 独立交付事实/催办 | NOT RUN |
| AC-O02 | 安全保留清理/持久业务去重（局部去重已测） | NOT RUN |


最终基础批次：完整189文件2257项通过；随后最新受影响7文件51项通过，当前Lint/类型检查通过；控制台50文件556项与构建通过。专属库smoke与临时本地allowlist下Mock SSO通过。整体仍TESTS BLOCKED/未完成（含未实现与NOT RUN项），不是27项业务验收通过。

## 2026-11-01 消息纵向切片技术证据（不替代上方27项业务AC）

| 技术用例 | 当前证据/结果 |
| --- | --- |
| TECH-M01 渠道加密、不可变URL、精确消费者、禁止地址Secret轮换、CAS/默认停用/保存不发 | message-channel-store/message-api；PASS |
| TECH-M02 模板草稿/发布/启用、严格变量、规则scope/渠道/模板资格、重复规则与引用保护 | message-api；PASS，真实UI已保存/发布/启用/版本读回 |
| TECH-M03 业务终态事务冻结规则/渠道/模板；回滚无outbox；按冻结目标恢复一次fanout | message-fanout；PASS |
| TECH-M04 最具体Job→Agent→API应用→组织→全局模板与全匹配记录 | message-fanout；PASS（用户实施确认），不代表Job来源已接通 |
| TECH-M05 Webhook精确正文/HMAC/有限重试；WeCom业务判定/未知不自动重试 | message-protocol/message-delivery；PASS |
| TECH-M06 prepared/submitted、过期租约、迟到证据、停用/改目标/撤销资格竞态 | message-delivery；PASS，submit二次资格检查 |
| TECH-M07 成功/unknown/最终超时/取消后重发重复风险；历史地址与过期/无效正文拒绝 | message-delivery/message-api；PASS |
| TECH-M08 21条同分钟节流不丢记录；等价机器人URL共用同桶；Retry-After存储日期边界 | message-quota-regression/message-dns-quota.log；PASS，含官方尾点域名同一配额桶 |
| TECH-M09 资源级幂等、CSRF/ETag、严格未知字段、分页/URI过滤、正文单独deny | message-api/message-sdk/route-schema-coverage；PASS |
| TECH-M10 四页签正常入口/刷新读回、固定模板重开、状态与attempt、补发确认和取消 | ego36正常页面+本机Mock；渠道/模板/记录已验，规则固定版本已读回；筛选竞态已修并刷新读回；渠道/模板390px实图已检查；Webhook补发后本机HMAC验证通过 |
| TECH-M11 审计安全before/after指纹/版本、生成OpenAPI/SDK/输入Schema同步 | message-audit-regression/message-contracts/结构回归；PASS，最新198文件2314项全量通过（system-reviewed-final.log） |

真实群、真实四项目业务样本、Linux执行器、旧App/计划迁移、完整Job执行恢复/人工/质量/评测尚未验收。保持原27项AC的NOT RUN/待验状态，不能合并上述技术用例冒充业务完成。

## 续作新增技术验证（业务AC仍按上表）

| 技术用例 | 证据/结果 |
| --- | --- |
| TECH-T01 Thread单活动Run、Run/首消息/事件原子受理、等待/终态指针、旧App来源核实 | run-thread-regression/run-thread-review-fixes/run-thread-terminal；PASS |
| TECH-T02 精确BIGINT新序号/旧NULL顺序、失租/终态/移交追加拒绝且无counter副作用、旧worker引擎隔离 | run-thread-protocol + 旧lease/集成回归；PASS |
| TECH-T03 016空库/升级/断点/重复、错误默认/索引拒绝；只清理创建成功的临时schema | configuration/job-core/identity/roles迁移真实MySQL；PASS，未重置已有库 |
| TECH-M12 createdFrom含/createdBefore不含、时区/别名冲突/毫秒边界及跨别名游标 | review-final-sdk-api；PASS，浏览器同会话GET规范参数400→200 |
| TECH-S01 SDK合法最小input编译/Schema自检，API/Store规范输出不放宽 | job-sdk/message-sdk + typecheck；PASS |
| TECH-JUI01 Job组织/负责人选择与业务/组织/状态URL筛选 | ego36正常入口，负责人保存刷新读回、已发布org锁定、390px截图PASS；未发布org在Forge/未分配之间双向保存刷新读回PASS，编辑无current哨兵 |

当前完整后端198文件2314项通过，控制台56文件598项通过；这些是局部实现的技术证据，不把27项真实业务AC改为PASS。
