# 账号生命周期与操作日志本地证据

2026-11-01；状态：LOCALLY VERIFIED（U01/U02及U05当前账号/现存管理入口增量）。需求/规则见[详细需求](../../20261031-233358-账号权限三方API与群通知-详细需求文档.md)，事务/接口/迁移见[开发设计](../../2026-11-01-forge-identity-design.md)。U03/U04/U06/U07/U08未由本页标完成；不代表整个框架完成、提交或部署。

## 已实现与用例

| CASE | 对象与结果 | 证据 |
| --- | --- | --- |
| I01 | 登录名/邮箱、本地密码原值；创建/编辑/部门分配/管理员设置；本人改密、管理员重置、撤销全部会话；普通账号改密可获取公开revision | account-lifecycle、user-admin、session系列；React与legacy正常入口实测 |
| I02 | 删除保留旧ID/历史，释放登录标识；重建新ID、self无法读旧Run、不自动继承SSO；管理员可明确重绑旧已删除subject而不转移旧数据 | account-lifecycle；UI删除→重建→新ID/空绑定读回 |
| I03/I11 | 最后可登录管理员保护；两个管理员并发撤销只一成功，另一409；无密码、坏哈希、未绑定、空角色映射不被误计；唯一SSO-only解绑拒绝并回滚 | identity-migration的隔离子进程真实Repository与MySQL测试 |
| I04 | 锁内重读操作者/目标授权；组织内更高范围账号不可被低范围管理员重置/改登录名/删除；撤销会话前已排队账号写也拒绝 | account-lifecycle；跨组织/平台资源写回归 |
| I05/I10 | 同邮箱未绑定拒绝；已绑定保留本地角色/范围/显示名/密码；issuer/sub二进制精确匹配；ID Token必需sub与nonce，Access sub/subject与其对齐；禁用/删除不JIT复活 | sso-explicit-binding、Mock SSO/Connector smoke |
| I06 | 旧密码核验→管理员重置→旧核验创建Session失败；旧Session全部401 | account-lifecycle |
| I07 | HMAC键MySQL节流；15并发最多10成功预留、429带冷却，到期恢复；成功清账号额度，未知/停用/畸形密码均统一认证失败 | account-lifecycle、login-dummy-hash |
| I08 | 操作者ID/名称快照、前后安全字段、成功/失败/拒绝统一动作码，错误解析后归一；组织可查自身失败；SQL范围、游标/详情和严格带时区日期 | account-lifecycle、audit全组、identity-contracts；账号详情→日志→详情实测 |
| I09 | pending/409草稿、关闭清密码、焦点恢复；空部门改名不迁移；自降权成功后刷新会话并跳有权页面；分页失败/双击及旧回包竞态恢复 | account-forms、API单测；双页409、390px表单/横滚、React改密字段定位实测 |
| I12 | seed按不可变bootstrap ID仅首次创建；删除后新ID复用邮箱且持会话重seed不会提权，原deleted不恢复 | identity-migration真实子进程执行db:seed |
| I13 | 已连接SSE每500ms串行重新认证/授权；改密、停用、撤会话、移出Run范围、Key撤销、App scope收窄后结束；轮询不重复计请求额度 | account-sse-revocation六个真HTTP用例；shutdown/SSE/API Key回归 |

## 最终验证

- [服务端182文件2192项通过](logs/server-tests.txt)。真实MySQL，包含迁移/并发/契约/运行/租约/SSO/出站/SSE；没有SQLite或内存库替代。
- [控制台45文件528项通过](logs/console-tests.txt)。包括未分配部门、回包竞态、确认pending、登录落点、自降权、字段错误等新增断言。
- [深测](logs/identity-deep-tests.txt)、[SSE定向30项](logs/sse-tests.txt)。010升级/空库/部分DDL组合/重复011/不兼容形状拒绝及Drizzle列/外键/索引一致性通过。
- [服务端构建](logs/server-build.txt)、[控制台构建](logs/console-build.txt)、[Lint](logs/lint.txt)通过；Lint仅4条原有Fast Refresh warning。errors:check与git diff --check通过。
- [38表Drizzle无Schema差异](logs/drizzle.txt)。Drizzle0003为唯一迁移器011执行，不新增第二套迁移历史。
- 最新API重启后[端到端smoke](logs/smoke.txt)及[Mock SSO/Connector smoke](logs/sso-smoke.txt)通过。未调用真实公司身份源/业务接口/企业微信群。
- 两面独立只读审查发现均修复、相关回归后复审通过；SSE补充差异单独复审通过，无未关闭的本增量P0–P2。

## 真实页面

Ego TaskSpace25，从React登录/侧栏进入账号管理，后续复用legacy与React正常入口。没有注入业务数据到DOM冒充结果。临时技术fixture均在本机独立库，所有密码/SSO参数为模拟值。

1. 新增账号→改名、设/取消平台管理员→未分配部门保持空→SSO绑定并重开读回。
2. 两页面同时编辑：先保存者提交；后保存者409仍保留“冲突草稿保留”。关闭重开可比较。
3. 管理员重置→用户名登录→legacy本人改密后退出→邮箱新密码登录；React本人改密错误定位当前密码（aria-invalid、焦点），成功退出。
4. 删除→原登录名/邮箱新建→新ID且绑定空；停用刷新读回→启用→撤销会话成功。自降权跳到可访问总览，不把已提交的成功误显示为账号列表403；随后由另一管理员恢复引导账号。
5. 账号详情按目标/操作者跳转操作日志，查询与详情显示前后值；移动布局横滚在表格内，页面宽390，改密/退出入口可见；Escape后密码清空且焦点返回。

图片： [账号桌面](screenshots/account-created-desktop.png)、[409草稿](screenshots/account-conflict-desktop.png)、[SSO绑定](screenshots/sso-binding-desktop.png)、[日志详情](screenshots/audit-detail-desktop.png)、[日志390px](screenshots/audit-mobile.png)、[账号重建390px](screenshots/account-recreated-mobile.png)、[重置密码390px](screenshots/reset-password-mobile.png)、[React改密错误](screenshots/react-password-validation.png)。早期图片用于对应行为，最终账号/布局以最后读回图与源码为准；密码截图仅掩码。

## 环境与限制

Node22.23.3、MySQL8.4.13。`forge_e1_20261031_test`跑回归；`forge_identity_20261101_ux`跑UI；`forge_e1_20261031_smoke_test`跑smoke。日常forge库未修改。临时3198 API/8090 Mock已停止；3197 UX API与TaskSpace25为后续已授权权限/接口功能复用，未将它们当生产部署。

真实SSO和真实业务/群消息未验收；原生200%缩放、跨浏览器、axe未运行。账号SSO issuer旧值NULL需要管理员明确重新绑定，不能用旧版本账号语义回滚。SSE在下一500ms轮询重新检查，已经授权发送的在途批次可结束，不承诺撤回已发送数据。后台U03/U04与完整框架其余E1–E8继续实施，不把本地测试数写成整体交付。
