# 控制台评审问题修复与本地验收

日期：2026-11-01（Asia/Shanghai）。范围：本轮 Impeccable 评审的5项优先问题及侧栏、表格、状态文案问题。**本轮界面范围已修复并完成本地功能验收；全仓门禁尚未全绿。**

沿用现有React/旧版控制台和接口，不新增依赖、数据库迁移、权限码或生产配置。已有工作区与并行Job/消息工作保留，没有提交、推送或生产发布。

## 修复与证据

| 原问题 | 修复 | 验证 |
|---|---|---|
| 草稿、调试、发布路径断开 | 新建Agent和新版本均保存草稿；试运行显式传versionId；发布独立确认。新版本入口沿用接口现有agent.publish权限 | 浏览器创建草稿、运行草稿1、发布草稿1、保存草稿2，再分别选择线上版和草稿2运行；读回确认执行版本和线上指针均正确 |
| Run结果被诊断块挤压 | 消息单列完整宽度，工具/事件折叠；事件自身换行 | 1440×900下消息宽640px，事件clientWidth/scrollWidth均640px，无整页横溢；[截图](screenshots/run-final-1440.png) |
| 审批丢失具体Run | 新版审批直达具体Run；新旧决定框补工具、原因、脱敏参数、时限与证据入口 | 用本地Mock模型及内置只读current_time生成真实待审批；从新版菜单进入正确Run，新旧确认框均验看，批准后持久化approved且Run成功；[新版](screenshots/modern-approval-1280.png)、[旧版](screenshots/legacy-approval-1280.png) |
| 配置与作用域依赖JSON/手填ID | 基础模型/预算字段、Skill/工具目录与高级JSON同步；详情可读摘要；凭据按名称/Key选目录，回显ID并保留高级回退 | 真实保存读回保留maxTokens等高级字段和基础成本改动；凭据resource/agent/id与选中对象一致；搜索隐藏选项同时清除旧提示；[截图](screenshots/secret-scope-1280.png) |
| Agent进入工作入口隐藏 | 新版名称与行主操作直达详情，旧版名称支持关闭后再次点击；保留按权限显示的调试/新版本/发布动作 | 浏览器重复打开同名对象，完整进入配置/调试/发布；角色只读测试继续通过 |
| 1280侧栏、表格和状态阅读 | 收紧导航冗余间距，保留行高及滚动；旧版次要动作收纳、短状态不拆字，常用状态中文化 | 最新构建1280×800下导航scrollHeight=clientHeight=664，最后入口完整；旧表格9个短列均nowrap，无整页横溢；[新版](screenshots/agents-final-1280.png)、[旧版](screenshots/legacy-agents-final-1280.png) |

短屏1280×560：长表单正文389px可视、1067px内容在内部滚动，操作区底部544px，Esc可正常取消。[截图](screenshots/agent-form-short-1280x560.png)。

## 关联回归

- MCP/OpenAPI取消再恢复保留原有完整allow组，不扩大工具白名单；也保留未列出的高级配置。
- 自由Spec中的对象、null和不支持结构不会使详情崩溃，仍可查看原始JSON。
- 资源目录按真实权限码读取；旧请求迟到不能覆盖新资源类型，失败/无权限/空目录明确提示并保留高级ID入口。
- 运行终态不再出现“弹窗成功、列表仍排队”；共享REST同步点更新列表，导航和请求序号保护旧响应不覆盖新页面或新状态。

完整读回数据：[browser-readback.json](browser-readback.json)。两个只读审查面均已关闭本轮有效发现：[流程复审](review-workflow.md)、[数据与异步复审](review-data.md)。

## 检查结果

| 检查 | 结果 |
|---|---|
| 控制台测试 | **54文件、586项通过**；[日志](checks/console-tests.log) |
| 控制台类型检查与构建 | 通过；[类型](checks/console-typecheck.log)、[构建](checks/console-build.log) |
| 本轮改动文件ESLint / diff空白检查 | 通过；[Lint](checks/changed-lint.log) |
| 服务端typecheck / build | 本轮运行通过；[类型](checks/server-typecheck.log)、[构建](checks/server-build.log) |
| 端到端smoke | 通过，含工具、审批、开放API、权限、SSE与租约恢复；[日志](checks/smoke.log) |
| smoke:sso | 本地Mock IdP的OIDC与Connector Principal通过；[日志](checks/smoke-sso.log) |
| 配置/目录只读自检 | 14项通过，含白名单反复切换、晚到目录、搜索、错误与异常Spec；[自检脚本](review-data-selfcheck.mjs) |
| 全仓Lint | **未通过**：运行时Job/消息前端有34条no-floating-promises错误；[日志](checks/full-lint.log) |
| 全仓后端测试 | **2261通过、25失败（10文件）**；失败涉及并行Job/消息的Schema、契约/路由覆盖、消息幂等scope长度及超长消息等；本轮未改后端源码；[日志](checks/full-test.log) |
| 独立integration/contract命令 | 当前package.json未配置；完整pnpm test已运行真实MySQL及契约相关用例，不将缺失命令记为通过 |

全仓工作处于并行开发，以上全仓结果仅代表本轮实际运行时点，不代表整体可发布。完整摘要与失败名称见[verification-summary.json](verification-summary.json)。未削弱测试、跳过失败或为绿灯改并行代码。

## 环境与边界

- 使用两个本轮新建的本机MySQL测试库：浏览器/冒烟与后端回归隔离；未迁移日常forge、forge_ux或生产库。
- 后端迁移探针需创建临时库、查看锁及触发器；初次普通测试账号权限不足，之后仅在本机隔离回归库使用现有本地管理员权限重跑，未放宽生产配置。
- 正式浏览器验收使用ego lite的独立任务空间及本轮服务，后续使用localhost:3165；全部模型为离线Mock，工具为本机Mock或内置只读工具。测试对象、凭据值均为本轮隔离数据。
- 未验收生产SSO/真实Connector、真实模型效果、完整辅助技术和触屏矩阵；保留原有安全边界。浏览器、持久化、构建与生产状态分别记录。
- 本轮只修改[变更清单](changes.patch)所列18个源码/测试/文档文件；运行代码与最终验收版本一致。[源码指纹](source-hashes.json)记录交付时状态。收尾仅补充DESIGN证据链接；控制台设计文档同期追加的Job/消息进展属于并行工作，未计入本轮差异。

## 收尾

已关闭本轮ego任务空间35且不保留页面；三个临时服务进程组均正常停止；两个隔离测试库及对应临时授权均已删除并复核。未清理其它项目资源，结果见[cleanup.json](cleanup.json)。

原评审快照`2026-11-01T05-29-22Z__src-main-tsx.md`已按确切身份关闭，复核`closed: true`；历史评分23/40保留，未重新评分。[关闭记录](critique-closure.json)。

### Stop钩子字体提示复核

`overused-font / Inter`已复核为保留现有设计的例外：HEAD已使用相同字体栈，本轮是企业控制台可用性修复，浏览器验收未发现字体可读性缺陷。通过官方`hooks ignore-value`命令，仅在`apps/console/public/styles.css`中忽略Inter这一值；配置保存在仓库根`.impeccable/config.json`，未关闭规则或整文件检测。没有新增界面修改或未决字体问题，仅检测配置变更，未重跑功能测试。

### 后续全仓门禁已收尾

用户随后明确要求修复Job/Message剩余门禁失败。最新候选已在Node24通过完整`pnpm verify`（2314项后端、598项控制台，零失败/零跳过）、build及三种本地smoke；原始失败记录保留其当时时点。[后续修复与验证](../../.closed-loop/tasks/20261101-job-message/quality-reports/20261101-console-followup-gates/README.md)。
