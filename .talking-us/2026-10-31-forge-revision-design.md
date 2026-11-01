# E1 配置并发编辑与 Schema 准入

日期：2026-10-31；关联 W01 §4.1、接口设计§1、数据设计§1；本设计启动前实现没有revision列或If-Match检查；当前实施/验证结果见开发进度。范围是现存配置写入口及其读回/调用方；不缩减其余框架需求。

## 1. 确定契约

- 配置行增加`revision INT UNSIGNED NOT NULL DEFAULT 1`。新增资源从1开始；创建后发生子版本绑定/工具发现等实际配置写入时可以继续递增，响应/列表总是给出实际revision。
- 用户修改必须携带单个强标签`If-Match: "<revision>"`，revision为1–4294967295的十进制整数；不接受弱标签、通配符、列表或无引号值。缺少428 CFG-8505，格式错误400 CFG-8501，版本冲突409 CFG-8503。先完成认证/权限/资源可见性/原有输入校验，再检查前提，避免取代401/403/404/原400。
- 配置修改以同一事务里的`UPDATE ... WHERE id=? AND revision=?`完成，成功revision+1，与审计同事务；冲突/审计失败不得留下配置或审计。空字段更新检查版本但不增加revision；到达UINT上限409。
- 配置读回与更新响应增加revision；详情/修改给出ETag。ETag用于配置写入前提，普通读取不实现If-None-Match缓存捷径（动态展示字段不参与配置版本）；响应采用no-store。现有管理接口为内部契约，本批所有维护中调用方一起迁移，不保留隐式无锁写入。
- 内部自动化写入必须显式声明`system`更新意图，在行锁下取当前revision并递增；不是用户修改的兼容旁路。仅操作时钟/lastUsed等运行状态不增加配置revision；自动停用、安装/卸载改变配置可用性时必须增加。
- 原生/React控制台在打开表单/确认操作时捕获revision，提交此版本，绝不临时GET最新版本后覆盖。409保持输入，提示重新打开/比较；失败不自动重试。脚本/SDK按先读后条件写入迁移。

## 2. 对象与入口

| 对象 | 现存入口/行为 |
| --- | --- |
| Agent | PATCH元数据/API开关、POST版本/发布；子版本/发布指针写入与parent revision原子提交；重复发布不重复审计 |
| Skill | PATCH元数据、POST版本/发布；不可变版本内容不作为可覆盖草稿 |
| MCP | PATCH源、POST refresh；发现期间不持有数据库事务，提交工具目录前再次CAS，失败不覆盖新配置/目录 |
| Provider / Model | PATCH；模型独立版本，创建子模型不视为覆盖Provider配置 |
| API App | PATCH；Key生命周期独立沿用已实现的撤销/幂等，不用CAS阻止安全撤销 |
| User / Service Account | PATCH；用户停用与会话删除同事务；SSO权威角色同步声明system并使旧表单失效 |
| Schedule | PATCH、enable/disable；next_run_at/last_run等时钟推进不增版本，自动停用增版本 |
| Role mapping | 新code可POST创建；已有code的upsert须携带所读revision，不能把创建表单变成覆盖入口 |
| Plugin installation | 卸载检查/资源停用需验证已读版本；生命周期状态变化使旧管理表单失效 |
| 工具/工具源/路由/组织/策略/设置 | Schema补revision供已有系统写入与后续正式管理入口使用；没有实现的CRUD仍保持未完成，不新增空表 |

Config表：agents/skills/mcp_servers/mcp_tools/tool_sources/tools/llm_providers/llm_models/llm_routes/api_apps/users/service_accounts/schedules/oidc_role_mappings/plugins/org_units/data_policies/settings。不可变版本、日志、事件、运行、审批、Key状态不按普通配置PATCH处理。

## 3. Schema与迁移

- 使用已核实的稳定drizzle-orm0.45.4（Apache-2.0）/drizzle-kit0.31.11（MIT）。官方文档支持从已有MySQL读取schema并将生成SQL交给外部迁移执行器：[existing MySQL](https://orm.drizzle.team/docs/get-started/mysql-existing)、[generate](https://orm.drizzle.team/docs/drizzle-kit-generate)。
- 只对新建的本地`*_test`基线库做只读pull；不使用pull --init/push/migrate，不创建第二套迁移历史。现有001–008、mysql2 Repository和schema_migrations继续权威执行。
- Drizzle schema由现有001–008的隔离库形成基线；基线snapshot仅用于后续差分，不重复执行CREATE。009 SQL只允许新增revision，逐条核对，不自动改字段类型、约束或排序规则。bootstrap schema.sql同步新列。
- 现有执行器按缺列检查幂等应用009（MySQL DDL不能靠事务回滚）；所有列成功后记录迁移。中断可重跑；新服务启动前执行迁移，旧服务兼容新增列。旧进程不递增revision，因此正式启用并发编辑前需排空旧配置写进程；回退保留列，不删历史数据。
- 新schema变更继续由db:generate生成SQL，经过审查接入唯一db:migrate；Schema检查覆盖配置revision及已有列，不能把Drizzle可生成SQL当成已执行。

## 4. 反例/验收

REV-01空库/008升级/重复/部分DDL后恢复；REV-02缺失/弱/列表/越界header；REV-03两并发编辑仅一成功且一审计；REV-04审计失败回滚；REV-05无权限/未知资源保持原状态码且无写入；REV-06运行时自动停用使旧form失效、时钟推进不制造冲突；REV-07MCP发现期间源更新导致旧目录提交拒绝；REV-08UI保存冲突保留草稿，刷新后明确重新编辑；REV-09所有现存配置写入口和所有维护中调用方迁移。前端复用现有主题，不新增说明面板。

状态：LOCALLY VERIFIED；Drizzle生成物与迁移已在独立真实MySQL验证并接入，完整权限/快照/Thread等后续批次不因此关闭。
