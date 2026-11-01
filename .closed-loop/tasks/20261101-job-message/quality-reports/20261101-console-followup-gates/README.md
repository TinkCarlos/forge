# Job / Message 全仓门禁收尾

2026-11-01，本地验收。**最新交付候选在 Node 24.22.1 / MySQL 8.4.13 下通过 `pnpm verify`：后端 198 文件、2314 项，控制台 56 文件、598 项，零失败、零跳过。** 最新候选验证期间源码保持一致，指纹见 [final-source-hashes.json](final-source-hashes.json)。没有提交、推送或部署。

## 实际修复与协作边界

- 历史记录的34条lint错误，在本次最新复现时已因并行工作减少到8条；原25项后端失败在当前代码中均已有相应修复。本次保留这些实现，以当前完整运行结果判断剩余问题，不重复覆盖并行代码。
- Job页原8处未处理Promise，统一复用已有`onReject`，覆盖保存、目标目录重试、筛选、列表刷新/重试、分页与确认操作。保持原有业务错误处理、草稿、权限与pending逻辑，没有关闭lint规则。后续新增筛选沿用了相同处理，当前共10处。
- 审计扫描器原用正则把`action: "retry" | "cancel"`参数类型误当成审计事件。改为解析实际对象属性，保留审计调用扫描与分类表；反例同时证明类型注解不产生假事件、真实字符串值仍能被捕获。
- 新增016会话约束、配套夹具与企业微信尾点域名归一化由后台会话完成。本次提供全量失败证据、验证Node24脱敏181项及SDK/真实MySQL限频17项通过；没有放宽活跃Run写入保护或限频断言。
- 已获用户明确授权，与后台及配置界面两个会话协调；保留它们的结构化表单、组织/负责人/筛选、SDK与迁移实现。最小修复快照：[Job错误处理](jobs-lint-fix.patch)、[审计扫描](audit-fix.patch)。这些快照记录修复时的改动，最终候选另以源码指纹和全仓结果为准。

## 最新候选检查

| 检查 | 结果与证据 |
|---|---|
| `pnpm verify` | **通过**；含错误注册表检查、前后端类型检查、全仓lint、控制台构建、完整后端及控制台测试；[完整日志](checks/node24-handoff-verify.log) |
| 后端测试 | **2314通过、0失败、0跳过**，包含真实MySQL、迁移及契约检查 |
| 控制台测试 | **598通过、0失败、0跳过** |
| 全仓lint | **0错误**；保留4条既有Fast Refresh警告，未抑制它们 |
| `pnpm build` | 通过；[日志](checks/handoff-build.log) |
| `pnpm smoke` | 通过，使用重新启动的最新Node24 API；[日志](checks/handoff-smoke.log) |
| `pnpm smoke:edit` | 通过；[日志](checks/handoff-smoke-edit.log) |
| `pnpm smoke:sso` | 本地Mock OIDC / Connector Principal通过；[日志](checks/handoff-smoke-sso.log) |
| 全仓`git diff --check` | 通过 |
| 独立`test:integration` / `test:contract` | package.json未配置，不记为通过；相应真实数据库及契约用例已在完整`pnpm test`中执行 |

摘要：[verification-summary.json](verification-summary.json)。本轮差异Solo复审：[solo-review.md](solo-review.md)。

## 浏览器与读回

使用ego lite独立任务空间38、localhost:3175与本轮隔离数据库，从正常登录和侧栏入口操作：

- 创建Job；129码点名称得到服务端内联错误并聚焦名称，Key与预算草稿保留，确认没有写入对象；修正后保存成功。
- 刷新读回预算`0.250000`、草稿状态；独立发布后版本数为1，线上版本指针正确，筛选和刷新保持对象可见。
- 实际停止仅本轮API：列表和执行目标均显示可重试错误。恢复最新服务后自动重取成功，尚未保存的名称保留。一次旧ref点击因节点已被替换而失败，已检查当前页面；不把它当产品缺陷或人工重试成功证据。
- 消息渠道、规则、模板、发送记录四页签均从可见入口进入，正确显示空态，无越权或发送动作。
- 最后使用最新构建再次正常登录、刷新Job，预算和发布指针保持，页面无横溢；未把Mock或源码检查当生产业务验收。

读回：[browser-state.json](browser-state.json)。截图：[错误与草稿](screenshots/job-validation.png)、[发布](screenshots/job-published.png)、[真实连接失败](screenshots/job-offline-errors.png)、[恢复](screenshots/job-recovered.png)、[消息页签](screenshots/messages-tabs.png)、[最终Node24构建](screenshots/job-final-node24.png)。

## 中间失败与版本界限

- 首轮完整运行2299通过、1失败，定位并修复了审计扫描误报；[原始日志](checks/test-before.log)、[定向回归](checks/audit-targeted.log)。
- Node22多环境检查曾恰遇016迁移代码与JSON配套文件约9秒的写入间隔，出现缺文件；严格校验保留，没有加入重试掩盖未完整落盘的候选。[记录](checks/verify-envs.log)。
- Node24首轮development曾在新会话保护与旧夹具交错时失败/跳过，并暴露机器人尾点域名限频问题；修后分别复测，未删除或跳过用例。[原始矩阵](checks/node24-verify-envs.log)。
- 截至15:16:38，前一候选的Node24 development/test/unset均已通过，每种环境为2309项后端＋598项控制台、零跳过；development补跑见[日志](checks/node24-development-final.log)。
- 15:17又有一批并行改动落盘。本次没有沿用旧候选绿灯：对最终新候选重新执行了完整`pnpm verify`、build和三种smoke，得到上述2314/598结果，并确认最终验证窗口内637个源码输入指纹未变化。**前一候选的三环境矩阵不是最新候选的矩阵结果**，没有这样混用声明；新批次未再次扩展完整三环境矩阵。

## 环境和收尾

仅使用本轮新建的三个本机`gates..._test`库，没有重置已有测试库、日常库或生产库。使用现有本地管理员权限做迁移探针，没有放宽生产配置。Node24只通过进程PATH选择，没有修改全局默认Node。Mock、内置只读工具及技术数据不代表真实SSO、真实模型或群通知验收；本记录不关闭原Job完整运行时及27项真实业务AC，后续范围仍见[项目进度](../../progress.md)。

临时页面、服务、测试库与私有登录文件的实际清理结果见[cleanup.json](cleanup.json)。
