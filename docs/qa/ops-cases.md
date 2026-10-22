# 部署与运维用例（OPS）底稿 · 运维专家 · 基于 543b664
执行环境：临时实例用 3196（只绑 127.0.0.1）+ 临时 .env 副本 + 库 forge_ops；不碰 3100/3198/3197/3199、forge/forge_ux/forge_test。

| 编号 | 模块 | 类型 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| OPS-001 | 启动 | 异常 | 临时 .env 删掉 DATABASE_URL | pnpm start | 进程非 0 退出，报错点名缺的变量，不打印其它变量值 | P0 |
| OPS-002 | 启动 | 异常 | 依次删 FORGE_MASTER_KEY / SESSION_SECRET / API_KEY_PEPPER | 同上 | 同上，每个变量各一次 | P0 |
| OPS-003 | 启动 | 边界 | 上述密钥设为过短值（如 3 位）、空串 | 同上 | 拒绝启动或明确告警；报错不回显密钥值 | P1 |
| OPS-004 | 启动 | 异常 | DATABASE_URL 指向不存在的库 / 错误口令 / 关掉的端口 | 同上 | 明确报错；日志里不出现连接串中的口令 | P0 |
| OPS-005 | 启动 | 异常 | 端口已被占 | 同上 | EADDRINUSE 明确报错并退出，不僵死 | P1 |
| OPS-006 | 启动 | 边界 | PORT=0/70000/abc，HOST 非法 | 同上 | 校验失败明确报错 | P2 |
| OPS-007 | 启动 | 功能 | NODE_ENV=production 且 FORGE_ADMIN_PASSWORD 为示例默认值 | 同上 | 拒绝启动或强告警 | P1 |
| OPS-008 | 健康检查 | 功能 | 正常运行 | GET /healthz、/readyz | 200；响应不含版本以外的内部信息 | P1 |
| OPS-009 | 健康检查 | 异常 | 运行中停掉 MySQL | GET /healthz、/readyz | healthz 200、readyz 非 200（503）；恢复后 readyz 自动回 200，无需重启 | P0 |
| OPS-010 | 运行中断连 | 异常 | 运行中停 MySQL 30s 再恢复 | 期间访问管理接口；恢复后再访问 | 期间 5xx 且有结构化错误日志、无堆栈外泄给客户端；恢复后正常，进程不退出 | P0 |
| OPS-011 | 优雅停机 | 功能 | 有运行中的 Run | 发 SIGTERM | 不再接新请求、在途请求完成、租约释放，日志有 shutdown 记录；退出码 0 | P1 |
| OPS-012 | 重启恢复 | 功能 | 已登录会话、已有定时任务、kill -9 中断一个 Run | 重启 | 会话仍有效；定时任务照常触发且不重复触发；被中断的 Run 租约过期后被接管或标记失败，不永远卡 running | P0 |
| OPS-013 | 嵌入 worker | 功能 | EMBEDDED_WORKER=true/false 各一次 | 启动并跑一个 Run | true 时 api 内处理；false 时只有单独起 apps/worker 才处理 | P2 |
| OPS-014 | 日志 | 安全 | LOG_LEVEL=debug；已知 app.ts 的 pino 未配 redact，Fastify 默认请求日志不记头和 cookie | ① 请求 URL 查询串带 token/key/secret/password（如 `/next/cb?token=T`、`/admin/api/runs?api_key=K`）② 触发会主动 log 错误对象的路径：坏 JSON、校验失败、模型/工具调用失败（请求体含 apiKey、webhookSecret、password 字段）③ 登录错误口令 | 日志全文 grep 不到查询串里的密钥值和请求体中的敏感字段原文；有明文则定 P0，修复走 args-preview 共用判定函数 + pino redact 路径 | 待实测定级 |
| OPS-015 | 日志 | 功能 | 制造 400/401/403/404/409/500 | 查日志 | 每条有时间、级别、请求 id、路由、状态码；500 有堆栈但只在服务端日志 | P1 |
| OPS-016 | 日志 | 功能 | 正常运行 | 检查日志输出方式 | 记录是否只写 stdout（依赖 nohup 重定向）；无轮转则记为建议项并在部署文档写明 | P2 |
| OPS-017 | 日志 | 边界 | 请求体含超长字符串 / 换行 / ANSI 控制符 | 发请求 | 日志不被注入伪造行，单行长度有上限 | P2 |
| OPS-018 | 构建 | 功能 | 干净 clone | install --frozen-lockfile → build:console → start | 一次通过；/next/ 200，资源路径都在 /next/ 下 | P0 |
| OPS-019 | 构建 | 性能 | 同上 | 记录 dist 体积、JS 原始/gzip、最大 chunk、首屏 TTFB/FCP/LCP（本机冷缓存） | 产出基线数；当前 dist 1036KB、JS 911KB/gzip≈283KB，最大 chunk 超 500KB 告警记为一般 | P1 |
| OPS-020 | 静态资源 | 功能 | 运行中 | 请求 /next/assets/* 与 /next/index.html | 带 hash 的资源长缓存，index.html no-cache；刷新子路由回 index.html | P2 |
| OPS-021 | 网络暴露 | 安全 | 默认 .env.example | 启动看监听地址 | 默认只绑 127.0.0.1；HOST=0.0.0.0 时日志有告警（当前开发 .env 为 0.0.0.0，待 Cursor Jackson 决定） | P1 |
| OPS-022 | 依赖 | 安全 | 干净 clone | pnpm audit --prod | 无 high/critical；有则列包名和版本 | P1 |
| OPS-023 | 部署文档 | 文档 | 无 | 按 docs/06-operations/deployment.md 从零走一遍 | 文档步骤能直接跑通，含 build:console | P2 |

读代码顺带发现（待用例测实）：仓库里 grep 不到 `redact`，logger 可能没配日志脱敏 → OPS-014 重点。
