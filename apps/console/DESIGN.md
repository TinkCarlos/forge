# Forge Console 组件规范

新控制台（Vite + React + Tailwind v4 + shadcn 风格组件）。旧版 `public/` 在新版功能对齐并通过 UX 审核前保持可用。逐条供 UX 审核。

## 1. Token
- 全部颜色定义为 CSS 变量（`src/index.css`）：background / foreground / card / muted / muted-foreground / border / primary / destructive。
- 语义色 success / warning / info / destructive 各有实色与浅底（`*-soft`）两档。
- Tailwind 只引用变量（`bg-primary`、`text-muted-foreground`），组件里不写死色值。
- 暗色为 C 套，作为 `.dark` 覆盖；色值待 UX 给定。

## 2. 字体
- 字号仅 12 / 13 / 14 / 16 / 20 / 28（`text-xs` 到 `text-2xl`）。
- 字重仅 400 / 500 / 600。中文最小 12px。表头不用大写。

## 3. 间距与圆角
- 间距 8 / 12 / 16 / 24 / 32。
- 圆角：控件 6（`rounded-control`），卡片 10（`rounded-card`），弹窗 14（`rounded-dialog`）。

## 4. Button
- 每个区域最多一个 primary。变体：primary / outline / ghost / destructive / link。
- 尺寸：sm 32px，md 36px。
- loading：显示 spinner 并禁用，宽度不变。
- 纯图标按钮必须有 `aria-label` 和 tooltip。

## 5. AlertDialog
- 标题 = 动词 + 「对象名」，例如「发布「客服助手」v3」。
- 正文写清影响以及能否撤销。确认按钮重复动词。
- 默认焦点在「取消」。不可逆操作需输入对象名确认。

## 6. Table
- 首列为名称，下方灰字显示 key。ID 显示前 8 位并带复制按钮。
- 行高 44。每行一个主操作，其余放「⋯」菜单。
- 筛选：搜索 + 状态 Tab + 下拉。分页每页 20 条。
- 必须有加载骨架、空态和出错重试。

## 7. StatusPill 映射
| 状态 | 语义 |
| --- | --- |
| succeeded / enabled / active | success |
| queued / running | info（running 带脉冲点） |
| awaiting_approval / disabled | warning |
| failed / rejected / expired / budget_exhausted | destructive |
| cancelled | neutral |
| 未知值 | 原文显示，neutral |

## 8. 格式化
- 成本为 0 显示「—」。
- 时间显示 MM-DD HH:mm，悬停显示完整时间和时区。

## 9. Toast 与错误
- 成功 toast 3 秒自动消失。错误 toast 需手动关闭，并显示错误码。
- 表单错误显示在对应字段下方。

## 10. 布局
- 不用面包屑：页面顶部是 h1 标题加一行说明（`PageShell`），卡片里不重复标题。侧栏图标用 lucide。
- 动效：弹窗/菜单进入 150–200ms、退出 100–150ms，抽屉开 250ms 关 200ms，页面切换 180ms，曲线 ease-out；列表行纯淡入，错开上限 120ms。开启「减少动态效果」时全局压到 1ms。
- 确认弹窗关闭后焦点回到触发按钮（菜单里打开的回到 ⋯ 按钮），触发按钮已消失时回到页面 h1。
- 搜索与账号弹窗同样恢复打开前的焦点；菜单启动的账号弹窗返回用户菜单按钮。修改密码前说明至少 8 个字符及成功后需重新登录。
- 旧版入口统一在新标签页打开并标明去向；只进入旧版列表的创建入口标为「去旧版新建」。
- 桌面侧栏分组标题高 24px、组间距 4px，分组只保留左右 8px 内边距；导航行仍为 32px，触屏至少 44px。1280×800 下完整导航可见，较矮窗口继续允许侧栏滚动。
- 审批中心导航项显示待审批数角标。API/数据库不可用时顶部显示横幅。

## 固定文案
- 定时任务身份：「以服务身份运行（普通用户权限，数据范围为创建者所在部门）」。
- 关闭开放 API：「关闭后外部应用无法再发起新调用；已在运行的任务会继续完成，结果仍可查询。之后可以随时重新开放。」

## 构建与挂载
- 开发：`pnpm dev:console`（5175 端口，代理到 `FORGE_API_URL`，默认 `http://127.0.0.1:3100`）。
- 构建：`pnpm build:console`，产物在 `apps/console/dist`，`base` 为 `/next/`，由 API 用 `@fastify/static` 挂在 `/next/`。
- 类型检查：`pnpm typecheck:console`（根 `tsconfig.json` 已排除 `apps/console`）。

## 2026-11-01 体验打磨

- 沿用现有新旧控制台视觉基线，本轮未选择新的视觉方向。
- 新版 Dialog / AlertDialog 高度不超过 `100dvh - 32px`，长内容在弹窗内滚动，保留 Radix 背景滚动锁；长标题允许换行。搜索浮层同样支持短屏滚动。
- 搜索页面入口与侧栏共用权限过滤；「跳过导航」定位并聚焦主内容。
- 旧版桌面导航压缩分组留白，窄屏保留横向导航；切换时当前项可见，键盘操作后保留焦点。表头使用 12px；手机页头操作换行，四列及以上表格保留最小阅读宽度并局部横滚。
- 旧版弹窗进入为 180ms 的透明度与 6px 位移过渡；正文单独滚动，头部与操作区保持可达。系统开启减少动态效果时，动画和过渡压到 1ms，并取消按钮按下位移。
- 本地截图、逐页检查范围与未验证项见 [本轮体验检查](../../.design-evidence/2026-11-01-frontend/design-review.md)。截图用于核实实现，不代表用户已认可新稿或生产验收。

## 2026-11-01 评审问题修复

- Agent 创建和新版本使用「保存草稿」；试运行必须明确版本；发布独立确认。详情先呈现可读配置与任务入口，原始 JSON 折叠。
- Run 消息使用完整内容宽度；工具和事件折叠展开，不得挤压消息。审批关联 Run 使用对象深链接。
- 凭据作用域目录按当前权限读取，支持名称/Key查找并回显ID，目录失败显示原因与高级输入。
- 新版导航组内不额外叠加行间距，仍保留32px导航行和触屏44px目标，容纳新增Job导航；次要行操作收纳，短状态不拆字。
- 本轮修复、截图和本地验收边界见[控制台修复记录](../../.design-evidence/2026-11-01-console-fixes/verification.md)。
