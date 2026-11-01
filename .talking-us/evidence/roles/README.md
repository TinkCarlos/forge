# U03 全局角色本地证据

状态：LOCALLY VERIFIED，2026-11-01。范围为[全局角色设计](../../2026-11-01-forge-roles-design.md)，不是完整 U03/U04 或完整框架完成。组织/组作用域、deny 优先完整数据策略、部门树仍待实施。

## 覆盖与验证

| 对象 | 断言与证据 |
| --- | --- |
| 实际授权 | `tests/configurable-roles.test.ts`：自定义主角色无user默认权限泄漏；多角色并集/去重；停用/恢复/旧绑定保留；低权者不能接管停用高权角色或附加管理员身份；现有session下一请求撤权 |
| 写入竞争/保护 | 同上：CAS一成功一409；缺版本428；平台固定/内置不可删；具体权限复制平台模板不会得到平台身份；引用删除409；排队请求在锁内重读被撤销权限；审计失败回滚权限/资料/revision |
| SSO/服务身份 | 同上及既有SSO/调度测试：自定义有效角色映射、受保护身份不能绕过用户授权上限、选角后映射或角色变更拒绝JIT且无新用户；服务角色撤权暂停调度。既有SSO绑定继续保留本地配置 |
| 发布权限 | 同上：agent.manage-only能建draft，publish=true403且无Agent残留；plugin.install-only安装Agent包得到唯一draft和空发布指针；后续发布仍需agent.publish |
| 迁移/初始化 | `tests/roles-migration.test.ts`：fresh/011升级一致、部分DDL恢复、重复运行保留空矩阵/停用/名称、非utf8默认库的新表仍显式utf8mb4；异常列/唯一键/FK规则失败关闭；seed不覆盖矩阵与SSO映射。既有configuration-migration继续比对全部列/FK/索引 |
| UI/契约 | `roles-forms.test.ts`、`login-destination.test.ts`和既有前端回归：OR页签入口、主/附加角色联动、409草稿、跨页签迟到成功/失败/详情、只读操作、关联目录按权限请求、提交后不误读禁止的Run；OpenAPI及既有用户白名单/输入Schema全覆盖同步 |

最终候选检查：

- 服务端 `pnpm test`：**184文件 / 2211项通过**，真实本机MySQL；原始日志 `/private/tmp/forge-roles-all-accepted.txt`。新增16项角色、3项迁移；不把失败轮次或交叉定向计为额外独立用例。
- 控制台 `pnpm test:console`：**47文件 / 540项通过**，`/private/tmp/forge-roles-console-final3.txt`。
- typecheck、typecheck:console、build、build:console、errors:check、diff检查通过；lint0 error、4条原有Fast Refresh warning；Drizzle42表、No schema changes。
- 重启最新候选于独立3198端口，独立smoke库迁移/seed后 `pnpm smoke`、`pnpm smoke:sso`通过：本地Mock OIDC/Connector；日志 `/private/tmp/forge-roles-smoke-accepted.txt`、`/private/tmp/forge-roles-sso-accepted.txt`。3198 API和本轮8090 Mock均已停止。
- 权限/事务/SSO与控制台/契约两面只读复审，发现已修复并定向及完整回归，无本批未关闭P0–P2。未改日常数据库，未提交/推送/部署。

项目没有独立test:integration/test:contract脚本；真实MySQL集成与契约随pnpm test运行。Node22、mysql2 Repository仍是当前运行方式，未将目标Temporal/Redis/Pi集成记为已完成。

## 真实浏览器

原ego空间25消失；经用户明确允许新建后使用**空间29**，只操作本地独立库 `forge_identity_20261101_ux` 和3197 API。p1为127.0.0.1上的管理员，p2为localhost上的普通账号，以主机Cookie隔离身份；不是修改服务器登录校验或伪造Principal。使用真实表单保存、刷新/重访读回。

1. 正常账号与权限入口→功能权限→创建自定义角色→勾选Agent查看/运行→保存与刷新读回。
2. 账号编辑指定自定义主角色+审计附加角色，详情显示并集；随后撤回附加角色、改角色为仅role.view。普通账号从React登录正常进入legacy功能权限页，仅该页签可见、无写动作：`screenshots/role-only-entry-final.png`。停用后重载拒绝POL-2001：`disabled-denied.png`；恢复后重新读回。
3. 角色复制→双页并发编辑，第二页提交成功，旧页409且保留“移动端保留的草稿”、仍可操作；`conflict-desktop.png`、`conflict-mobile-final.png`。旧草稿未覆盖服务器版本，关闭后刷新读回另一页已保存名称。
4. 已绑定角色删除409并保持确认框；解除绑定后允许删除，刷新不再显示。无引用副本删除后重访消失。128字符名称预览换行且关闭按钮可见，`long-name-mobile.png`。
5. 390px响应式通过CDP检查布局：页宽390、弹窗宽356、单列权限矩阵316px；表格宽806在356px容器内部横滚，修复按钮换行后普通行高62.5px，`list-mobile-compact.png`。这些是浏览器模拟布局截图；操作链在桌面浏览器执行，没有把它记为真手机触摸验收。

`list-mobile.png`为发现行高问题前截图；`list-desktop-final.png`、`edit-desktop-final.png`为桌面截图（已核实视口并命名），不冒充390px。`create-desktop.png`早于局部字段对齐修正。源角色/副本均为技术fixture，恢复普通账号原user/self授权后清理，不影响已有业务数据。

限制：未运行axe、真手机、跨浏览器或原生200%缩放；未做真实公司SSO/Connector/外部API/企业微信群消息、Linux执行器或生产验收。全局角色中的数据范围仍为既有简化实现；不能用本批证明deny策略/组组织绑定、Run策略快照或运行中工具的完整实时策略已经完成。


最终边界回归：user.manage+self能修改本人资料，不能移部门、提升scope或修改他人；真实GUI自改成功、仅1行本人且无新建入口，刷新后读回（self-profile-edit.png）。锁内组织授权查询复用事务连接，占满另19连接时无enqueue、不嵌套等待pool。两条新增与账号/服务/审计共86项定向及最终184文件2211项全量通过；权限面复审关闭。测试账号资料和user/self授权已恢复，测试角色清理后只剩6内置角色。普通登录Cookie保留，刷新可直接读取新权限，无需重新登录。
