# 基础批次审查

模式：两个独立只读面，契约/受理安全与表达式/迁移/消息协议；主代理补跨面调用方和最终差异。权威为四份20261101-113405定稿文档；基线session-baseline-20261101.json。

已关闭：PATCH省略默认值误覆盖、深层JSON递归、Secret UTF-8单位、图回环与依赖引用、SQL NULL deny、持久业务去重顺序；额外自查关闭幂等键旧表大小写排序、完整表单原值误拒绝、bootstrap重复索引/FK和错误码生成产物。

逐面复审未发现本批可证明的新P0–P2；没有把noop授权callback测试说成治理验收。后续governance必须在同事务装配真实主体/引用/授权，新增计划或消息消费者后须补删除引用检查。sender必须按cycleAttempts给有限重试计数，保存PATCH须合并后完整校验模板。

Standards：本批静态/技术验证通过。Spec：仅基础子范围对应，整体未完成。运行时验收：既有Mock smoke通过；Job/消息新用户任务与27条业务AC未跑。没有Job/消息API、UI、复杂流程/完整冻结、投递账本与真实外部依赖的完成声明。

证据：system-tests-final.log、final-focused-tests.log、migration-tests.log、smoke-dedicated.log、sso-smoke.log；MySQL8.4已测、8.0.30未测。测试隔离误重置forge_test的事实在progress.md单独记录，不被测试通过覆盖。
