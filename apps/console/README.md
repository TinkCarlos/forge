# @forge/console（新控制台，挂在 `/next/`）

界面骨架基于开源项目 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin)（MIT，许可证见本目录 `LICENSE`），
已去掉模板的 mock 数据、Clerk 登录和示例页面，登录改走 Forge 的 `/auth/*`。

- 技术栈：Vite + React 19 + Tailwind v4 + shadcn/Radix + TanStack Router / Query / Table
- 动画只用 `motion` 一个库；系统开启「减少动态效果」时自动降级为淡入淡出
- 构建：在仓库根目录执行 `pnpm build:console`，产物在 `apps/console/dist`，`base` 与 router `basepath` 均为 `/next`
- 本地开发：`FORGE_API_URL=http://127.0.0.1:3100 pnpm --filter @forge/console dev`
- 还没迁移的页面在侧栏里标为外链，跳回旧控制台 `/#<页面>`
