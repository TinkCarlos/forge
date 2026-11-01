# Forge 前端体验检查 · 2026-11-01

本轮按 FR-UI-15 / FR-UI-16 / NFR-10，检查并打磨现有控制台的共享导航、表格阅读、浮层可达性与低强度动效。沿用 `apps/console/DESIGN.md` 和真实本地页面作为视觉基线；没有选择新视觉方向、引入素材或依赖。保留工作区已有改动，没有提交、推送或生产发布。

## 实际环境与范围

- ego-browser TaskSpace 32；本地 API `http://127.0.0.1:3197`。React `/next/` 通过本轮重新构建的 `apps/console/dist` 验收，旧版加载当前 `public/` 文件。取证时关闭浏览器缓存。
- 使用现有本地管理员会话与已有数据：一个演示 Agent、Mock Provider、内置 Skill、已有账号/角色与日志；其余列表多为空。页面检查没有创建业务记录，没有提交发布、审批、密钥、账号修改或退出登录。
- 桌面旧版基线 1440×960，新稿 1280×800；窄屏 390×844（部分新版浮层 390×600）；补查 768×800、320×640、900×260。均为 Chromium 模拟 CSS 视口，不代表真实手机验收。
- 这是共享体验改动的检查记录，不是所有业务写操作、所有角色或完整无障碍认证。

## 发现与修改

| 问题 | 修改与依据 | 结果 |
| --- | --- | --- |
| 旧版导航留白过多，常见窗口下治理入口需要滚动；重绘后键盘焦点丢失 | 压缩分组与行间留白，账号操作并排；恢复当前导航焦点与可见位置，补 `aria-current` 与焦点环 | 1280×800 下全部菜单文字可见；键盘切到模型后焦点留在模型按钮 |
| 旧版窄屏表格将描述挤成单字一行，页头多操作挤压标题 | 四列及以上表格最低 640px，在原容器内横滚；既有账号 760px、审计/凭据 1050px 约束保留；卡片页头操作换行 | 390px 页面自身宽度仍为 390px；Agent 描述可按词组阅读，操作可横滚到达 |
| 新版弹窗无高度约束；900×260 下改密弹窗上缘 -27px、下缘 287px | 共享 Dialog/AlertDialog 限高 `100dvh - 32px`，内部滚动、长文本换行；搜索浮层保留纵向滚动；移除覆盖 Radix 背景滚动锁的样式 | 同视口改密弹窗 16px–244px，内部高度 226px、内容 312px；背景 overflow 为 hidden |
| 跳过导航没有目标；搜索没有按权限过滤 | 主内容补可聚焦 ID；搜索复用侧栏既有 `usePermissions` / `filterNavGroups` | 键盘激活跳过链接后焦点为 `MAIN#content`；权限过滤复用现有行为测试 |
| 旧版反馈缺少一致的焦点与减少动态处理 | 导航颜色 140ms；弹窗透明度与小幅位移 180ms，原生关闭即时；减少动态时 1ms，按钮取消按下位移；触屏控件命中区至少 44px | 实际按住按钮时，reduce 下 transform 为 none；正常/减少动态持续时间为 0.18s / 0.001s |

## 逐页视觉与状态

下列每页均保存并查看 1280×800 与 390×844 截图；默认态加载成功，未观察到整页横向溢出。数据仅核对当前页面来源和既有展示，没有重新定义统计或业务口径。完整 DOM 测量见 [route-checks.json](route-checks.json)，总览见 [桌面](route-overview-1280.jpg) / [窄屏](route-overview-390.jpg)。

| 路由 | 数据/状态 | 本轮结论 |
| --- | --- | --- |
| `/#agents` | 1 个既有演示 Agent | 通过：导航、页头、表格局部横滚；新建表单仅打开/取消 |
| `/#models` | 既有 Mock Provider / Model | 通过：卡片与页头换行 |
| `/#mcp` | 空列表 | 通过：空态与添加入口布局 |
| `/#skills` | 既有内置 Skill | 通过：表格阅读与局部横滚 |
| `/#tools` | 空列表 | 通过：空态与导入入口布局 |
| `/#packages` | 安装表单、无安装记录 | 通过：表单阅读、底部已安装区可达；未提交 |
| `/#runs` | 空列表 | 通过：空态与刷新入口布局 |
| `/#approvals` | 空列表 | 通过：空态与刷新入口布局；未验真实审批提交 |
| `/#schedules` | 空列表 | 通过：两个创建入口在窄屏换行 |
| `/#apps` | 空列表 | 通过：空态与创建入口布局 |
| `/#users` | 2 个已有账号 | 通过：筛选/表格布局；保留 760px 表格宽度 |
| `/#users/roles` | 6 个已有角色 | 通过：页签、角色表格布局 |
| `/#audit` | 既有日志 | 通过：筛选表单、底部日志区、1050px 表格内部横滚 |
| `/#secrets` | 空列表 | 通过：空态与创建入口布局；未创建凭据 |
| `/#sso` | 已有本地配置与映射 | 通过：状态卡与底部角色映射布局；未改配置 |

## 关键交互与边界

| 页面/浮层 | 操作与观察 | 结论/证据 |
| --- | --- | --- |
| 旧版导航 | 焦点移到模型按钮，Enter 切换；重绘后仍聚焦当前按钮，当前项在横向导航内可见 | 通过；补 `nav-focus.test.ts` 2 项回归 |
| 旧版新建 Agent | 390×844 / 320×640 打开未修改表单，正文可滚，底部取消/创建可达，Escape 关闭 | 通过；[390px](legacy-mobile-dialog-after.png)、[320px](legacy-320-dialog-after.png) |
| 旧版减少动态 | 模拟 prefers-reduced-motion，打开弹窗并实际按住按钮后读 computed style | 通过；[interaction-checks.json](interaction-checks.json)、[截图](legacy-reduced-after.png) |
| 新版改密弹窗 | 桌面账号菜单与手机侧栏账号菜单打开；短屏滚动至操作区；Escape 关闭后回账号按钮 | 通过；[修前](react-short-dialog-before.png)、[修后](react-short-dialog-after.png)、[手机](react-mobile-dialog-after.png) |
| 新版退出确认 | 打开后默认焦点在取消，取消关闭，账号会话仍在、焦点回账号按钮 | 通过；[截图](react-confirm-after.png)；未执行退出 |
| 新版搜索 | 点击搜索、输入审批，短屏列表可读，Enter 到审批中心 | 通过；[搜索浮层](react-command-after.png) |
| 新版 Agent 搜索 | 输入不存在关键词后显示准确空态；清空恢复既有 Agent | 通过；[空态](react-search-empty-after.png) |
| 新版跳过导航 | 聚焦跳过链接并 Enter | 通过；焦点 `MAIN#content`，见 [交互测量](interaction-checks.json) |
| 平板与窄屏 | 两套控制台补查 768px；旧版补查 320px 长表单 | 通过本轮画面；[新版平板](react-tablet-after.png)、[旧版平板](legacy-tablet-after.png)、[边界测量](boundary-checks.json) |

## 工程验证与限制

- 前端 Vitest：50 文件、556 项通过；包含本轮导航焦点回归。
- `pnpm build:console` / `pnpm typecheck` / `pnpm build` / `pnpm lint` 通过；Lint 有 4 条既存 Fast Refresh warning，无 error。
- `pnpm smoke` 与 `pnpm smoke:sso` 通过，覆盖本地 Mock 主流程与 OIDC / Connector；本轮临时 API、Mock 服务和 IdP 均已停止，保留原 3197 服务。
- 根 `pnpm test` 含真实 MySQL 集成与契约测试：178 文件、2197 项通过；6 文件受本机 MySQL 账户权限限制，3 项失败、11 项跳过。限制为临时建库/删库、读取锁等待视图及 binlog 下创建触发器，不是本轮前端断言失败；不能报告后端全套通过。没有单独的 `test:integration` / `test:contract` 脚本。
- 验证使用空闲的 `forge_test`，按标准迁移从 005 前向升级到 012 后运行测试与 Mock 冒烟；没有 reset/drop 现有库、修改业务库或改变数据库权限/全局配置。详细日志在本机 `/tmp/forge-frontend-verify-1101/README.md`。
- 本轮独立增量审查发现并修复了两处 CSS 特异性问题：减少动态下的按钮 active；窄屏表格宽度覆盖既有表格类。
- 未执行生产部署、真实 SSO/Connector 联调、真实移动硬件/Safari、浏览器原生 200% 缩放、完整性能/无障碍认证或全部业务写操作。受限角色搜索的浏览器登录态未覆盖，依据现有权限 helper 单测核对。
- 既有 `ConfirmDialog` 提交期间 Escape 关闭行为不属于本轮新增逻辑，尚未做真实提交态验收；本记录不宣称所有弹窗分支均已验收。

## 可打开预览与截图

- 本地新版：`http://127.0.0.1:3197/next/agents`；旧版：`http://127.0.0.1:3197/#agents`。
- [旧版桌面修后](legacy-desktop-after.png) / [旧版窄屏修后](agents-390.png)。
- [新版桌面](react-desktop-after.png) / [新版窄屏](react-mobile-after.png)。
- 延续了原有品牌、菜单结构与真实业务内容。未添加装饰动画、虚构统计或新功能；本轮未引入新的视觉参考或素材许可。
