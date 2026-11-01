# E1 凭据库本地交付证据

候选：HEAD `3cde87d` 加当前未提交工作区，2026-10-31；不代表提交、部署或生产验收。规格见[凭据设计](../../2026-10-31-forge-secret-design.md)。完整框架的后续范围仍保留。

## 自动化

| 检查 | 最终结果 / 原始证据 |
| --- | --- |
| 服务端完整测试 | 177文件、2168项通过；[server-tests.txt](logs/server-tests.txt)，本机真实MySQL 8.4.13独立`forge_e1_20261031_test` |
| 控制台测试 | 44文件、521项通过；[console-tests.txt](logs/console-tests.txt) |
| 类型/构建 | 服务端tsc与React/Vite构建通过；[服务端](logs/server-build.txt)、[控制台](logs/console-build.txt) |
| Lint | 0 error、4条原有Fast Refresh warning；[lint.txt](logs/lint.txt) |
| 业务冒烟 | 最新代码重启后通过；[smoke.txt](logs/smoke.txt) |
| SSO/Connector | 本地Mock IdP交换/角色映射、Principal验签通过；[sso-smoke.txt](logs/sso-smoke.txt)；不是公司真实SSO联调 |
| Schema | 37表Drizzle无待生成变化；010空库/009升级/部分DDL恢复/重跑，列/索引/FK比对通过，错误默认/ON UPDATE/索引和跨库FK拒绝 |
| 维护CLI | 新建独立临时`forge_secret_ops_*_test`，实跑migrate/rewrap；重复changed0，坏行保留且exit1、无明文输出，旧key移除后重新验证；结束删除临时库和keyring文件 |

SEC01/02：信封DEK、AAD换上下文及六种篡改拒绝、私有keyring热替换/损坏失败关闭；SEC03/04：管理元数据、原始空白字节保留、If-Match、并发轮换与审计回滚；SEC05/06：org精确而非子树、resource精确类型/ID、混合Header100/101、30个不同App/Provider并行首次绑定、5次绑定/删除竞态、停用后不能用旧列绕过；SEC07：本地真实HTTP五条边界，回显/JSON/SSE/工具标识符碰撞、HMAC及轮换、撤销后请求数不增加；SEC08/09：软删MCP旧值也回填、坏数据保留/重跑、系统审计与历史DEK重包裹。对应`tests/secret-*.test.ts`、`tests/secrets.test.ts`、`tests/credential-redaction.test.ts`、`tests/configuration-migration.test.ts`及现有契约/权限回归。

审查修复未放宽保护断言：旧Header明文断言改为“配置表无明文＋引用解密仍为原值”；HTTP Header名按大小写不敏感核对。完整回归中的早期失败包括候选修改期间模块/测试不同步，以及新DDL恢复测试自身缺少函数默认值括号；修复后冻结服务端完整重跑通过。

## 浏览器

ego lite TaskSpace 24，从正常控制台入口进入；复用测试登录，独立3197 API和smoke库。只使用合成技术凭据、本地Mock，不使用真实业务密钥或实际消息群。

| 页面 / 路径 | 操作及读回 | 证据 |
| --- | --- | --- |
| 凭据 | 创建平台凭据；值关闭清空；详情不返回值；双页编辑第二页成功、第一页409保草稿；轮换后重访读回历史版本；5个引用显示；有引用删除409；启停刷新读回；新建resource凭据再删除无引用项 | create-desktop、conflict-desktop、detail-rotated-desktop、list-desktop-final、list-mobile-final、create-resource-mobile、edit-tablet |
| Provider | 新建时用既有Secret ID同时绑定Bearer和Header；只改名保留绑定；新值输入取消后清空 | provider-edit-desktop、provider-edit-mobile |
| MCP | 绑定Header引用并实际发现2工具；改名后发现仍成功；输入临时Header取消后清空 | mcp-edit-desktop、mcp-edit-mobile |
| 应用 | 配置Webhook URL和已有Secret ID；编辑表单不回填旧值，输入新值取消后清空 | app-create-desktop、app-edit-mobile |
| 第三方工具源 | OpenAPI导入含Header引用并产生接口；新表单/取消状态 | source-import-desktop、source-import-mobile |
| React入口 | 治理侧栏“凭据”进入已实现的legacy页；未宣称新增React原生凭据页面 | react-entry-desktop |

截图均为本目录同名`.png`，已实际查看。桌面1800 CSS px、手机390×844、平板768×1024；手机早期列表逐字换行，局部增加表格最小宽度后`documentElement.scrollWidth=390`、表格内部1050px可横滚，最终图为list-mobile-final。原生Tab/Escape可用；取消返回原“轮换”按钮；成功重绘后原按钮移除，红灯测试复现焦点落BODY，修复后焦点回页面“新建凭据”，输入已清空。移动表单底部操作可达。

浏览器原生200%缩放、跨浏览器、完整axe审计未运行；这些不是本次技术测试的通过声明。线上Linux、真实SSO、生产凭据回填、旧备份恢复演练均未执行。两面独立审查覆盖加密/数据/迁移与API/运输/控制台，发现已修复并复审通过；最后局部焦点恢复由主代理审查、红绿测试及浏览器验证。

临时3197 API/8090 Mock已停止，TaskSpace 24已关闭；日常`forge`库未改。两份E1测试库保留供复查。业务配置/密钥数据不从测试环境推广到生产。
