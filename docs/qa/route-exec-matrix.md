# 路由执行矩阵（86 条）

> 源：`docs/qa/api-inventory.md` §1 接口总表（#1–#86，方法/路径/权限）＋后端审阅 `/tmp/forge-logs/api-cases-review.md` A2 表（已有用例、逐类缺口）＋`api-cases-addendum.md`（计划新用例）。脚本生成后人工核对。
> 执行：每行至少跑「未登录 / 一个拒绝角色 / 一个允许角色 / 非法参数（若有 body）」；admin 写请求一律带本会话 CSRF（I-CSRF-*）。逐角色期望见 I-RBAC-10（权限列 × inventory §3）。
> 缺口摘要符号：✗ 无用例 · ◐ 仅泛化；只列非 ✓/n/a 的类别。

| # | METHOD path | 权限 / 认证 | 已有用例 | 缺口摘要 | 计划新用例 | 执行 ✓ |
|---|---|---|---|---|---|---|
| 1 | GET `/` | 无 | F-LEG-01 | — | — | ☐ |
| 2 | GET `/next` | 无 | — | 400/边界: ✗ 302 | I-PUB-01 | ☐ |
| 3 | GET `/next/*` | 无 | F-SHELL-03、UI-012、S-08 | 400/边界: 未构建时 503 没有用例（I-PUB-02） | I-PUB-02 | ☐ |
| 4 | GET `/healthz` | 无 | I-G-10、O-07 | — | — | ☐ |
| 5 | GET `/readyz` | 无 | I-G-10、O-07 | — | — | ☐ |
| 6 | GET `/auth/config` | 无 | I-G-10 | — | — | ☐ |
| 7 | POST `/auth/local/login` | 无 | F-AUTH-02~04、S-03/04/32/33 | 403: ✗ `ALLOW_LOCAL_LOGIN=false` → 403 POL-2001（I-AUTH-02）；400/边界: ✗ `email` 传数字或布尔 → 400；停用用户用正确密码 → 401，文案相同（I-AUTH-03）；审计: ✗ 成功写 `auth.login.local`、失败不写（I-AUD-02） | I-AUD-02, I-AUTH-02, I-AUTH-03 | ☐ |
| 8 | GET `/auth/session` | Cookie | — | 401: ✗ | I-AUTH-01 | ☐ |
| 9 | POST `/auth/logout` | 可无 | F-AUTH-06 | 400/边界: ✗ 没有会话时也返回 200；不校验 CSRF（I-AUTH-04）；审计: ✗ 不写审计（第 6 个不写审计的接口） | I-CSRF-04, I-AUD-03, I-AUTH-04 | ☐ |
| 10 | GET `/auth/oidc/login` | 无 | F-AUTH-08、S-30 | 400/边界: ◐ `returnTo` 传不以 `/` 开头的值 → 回落成 `/` | I-AUTH-07 | ☐ |
| 11 | GET `/auth/oidc/callback` | 无 | — | 401: ✗ SSO-1204~1209；403: ✗ SSO-1201、SSO-1210；400/边界: ✗ SSO-1203；审计: ✗ `auth.login.oidc` | I-AUTH-05, I-AUTH-06, I-AUTH-08 | ☐ |
| 12 | GET `/admin/api/dashboard` | agent.view | I-SCOPE-03 | 403: ◐；404: n/a（全局） | I-RBAC-10 | ☐ |
| 13 | GET `/admin/api/agents` | agent.view | F-AGT-01、UI-020 | 403: ◐；400/边界: ◐ 无部门用户列表为空（I-SCOPE-12 有） | I-RBAC-10 | ☐ |
| 14 | POST `/admin/api/agents` | agent.manage | F-LEG-02（UI） | 403: ◐（OP/AU/US → 403）；400/边界: ✗ key 正则边界：1 位、2 位、64 位、65 位、大写、以 `-` 开头；重复 key → 409 CFG-8503；并发同 key → 500；`spec` 坏 JSON 静默用默认值（I-AGT-01~04）；审计: ✗ `agent.create` | I-CSRF-01, I-AGT-01, I-AGT-02, I-AGT-03, I-AGT-04, I-RBAC-10 | ☐ |
| 15 | GET `/admin/api/agents/:id` | agent.view | UI-025、I-RBAC-02、I-SCOPE-12 | 403: ◐ | I-RBAC-10, I-RBAC-11 | ☐ |
| 16 | PATCH `/admin/api/agents/:id` | agent.manage | F-AGT-04/05 | 403: ◐；404: ◐（I-RBAC-02 写了 PATCH，但没点名 Agent）；400/边界: ✗ `status` 传任意字符串会入库、超过 16 字符 → 500（I-AGT-05）；审计: ◐ F-AGT-05 写「有记录」，没写 action 名 `agent.update` | I-AGT-05, I-RBAC-10, I-RBAC-11 | ☐ |
| 17 | POST `/admin/api/agents/:id/versions` | **agent.publish** | F-LEG-02 | 403: ◐ 权限是 `agent.publish`，文档写的是 `agent.manage`；404: ✗ 跨部门；400/边界: ✗ 缺 `version` → 400；同一 agent 重复 version → 500（I-AGT-06/07）；审计: ✗ `agent.version.create` | I-AGT-06, I-AGT-07, I-RBAC-10, I-RBAC-11 | ☐ |
| 18 | POST `/admin/api/agents/:id/publish` | agent.publish | F-AGT-03 | 403: ◐；404: ✗ 跨部门；`versionId` 属于别的 agent → 404「版本不存在」；400/边界: ✗ 缺 `versionId` → 400（I-AGT-08/09） | I-AGT-08, I-AGT-09, I-RBAC-10, I-RBAC-11 | ☐ |
| 19 | POST `/admin/api/agents/:id/run` | agent.run | F-LEG-02 | 403: ◐（AU → 403）；404: ✗ 跨部门；`threadId` 属于别人 → 404「会话不存在」；400/边界: ✗ 指定草稿 `versionId` 也能跑；agent 已停用也能跑；没有可用版本 → 400（I-AGT-10~12）；审计: ✗ `run.create` | I-AGT-10, I-AGT-11, I-AGT-12, I-RBAC-10, I-RBAC-11 | ☐ |
| 20 | GET `/admin/api/providers` | model.view | F-LEG-10 | 403: ◐；400/边界: ✗ 响应里不能有 `apiKey`（I-MDL-01） | I-MDL-01, I-RBAC-10 | ☐ |
| 21 | POST `/admin/api/providers` | model.manage | F-LEG-10 | 403: ◐；400/边界: ✗ 缺 key 或 baseUrl → 400；重复 → 409；`timeoutMs=abc` → 500（I-MDL-02~04）；审计: ✗ `provider.create`，details 不含 apiKey | I-AUD-10, I-MDL-02, I-MDL-03, I-MDL-04, I-RBAC-10 | ☐ |
| 22 | POST `/admin/api/providers/:id/models` | model.manage | — | 403: ◐；404: ✗ 不存在 → 404；400/边界: ✗ 重复 key → 500；数值字段传 NaN（I-MDL-05/06）；审计: ✗ `model.create` | I-MDL-05, I-MDL-06, I-RBAC-10 | ☐ |
| 23 | PATCH `/admin/api/providers/:id` | model.manage | — | 403: ◐；404: ✗；400/边界: ✗ `apiKey` 传空串不覆盖原值（I-MDL-07）；审计: ✗ `provider.update` | I-MDL-07, I-MDL-08, I-RBAC-10 | ☐ |
| 24 | PATCH `/admin/api/models/:id` | model.manage | — | 403: ◐；404: ✗；400/边界: ✗；审计: ✗ `model.update` | I-MDL-08, I-RBAC-10 | ☐ |
| 25 | POST `/admin/api/providers/:id/test` | model.manage | — | 403: ◐；404: ✗；400/边界: ✗ 没有模型 → 400「Provider 还没有模型」；调用失败也返回 200 `ok:false`，`error` 里不能有内网地址（I-MDL-08~10）；审计: n/a（不写审计） | I-MDL-09, I-MDL-10, I-RBAC-10 | ☐ |
| 26 | GET `/admin/api/mcp` | mcp.view | F-LEG-10 | 403: ◐；400/边界: ✗ 响应里不能有 `headers` | I-MCP-01, I-RBAC-10 | ☐ |
| 27 | POST `/admin/api/mcp` | mcp.manage | S-26 | 403: ◐；400/边界: ✗ 缺 url → 400；重复 → 409；`url` 指向 `http://127.0.0.1`、`169.254.169.254` 这类私网地址不会被拦（安全项，转安全专家，I-MCP-02）；审计: ✗ `mcp.create` | I-MCP-02, I-MCP-03, I-MCP-08, I-RBAC-10 | ☐ |
| 28 | PATCH `/admin/api/mcp/:id` | mcp.manage | — | 403: ◐；404: ✗；400/边界: ✗；审计: ✗ `mcp.update` 的 details 里 `headers_json` 是明文（I-AUD-05） | I-AUD-05, I-MCP-04, I-RBAC-10 | ☐ |
| 29 | POST `/admin/api/mcp/:id/refresh` | mcp.manage | — | 403: ◐；404: ✗；400/边界: ✗ 上游返回非 2xx → 502 HTP-4001；连不上 → 500 SYS-9001（I-MCP-05/06）；审计: ✗ `mcp.refresh` | I-MCP-05, I-MCP-06, I-MCP-07, I-RBAC-10 | ☐ |
| 30 | GET `/admin/api/skills` | skill.view | F-LEG-10 | 403: ◐ | I-RBAC-10 | ☐ |
| 31 | POST `/admin/api/skills` | skill.manage | F-LEG-10 | 403: ◐；400/边界: ✗ 缺 key → 400；重复 → 409；`publish` 不传时默认就是发布；审计: ✗ `skill.create` | I-SKL-01, I-SKL-02, I-SKL-03, I-RBAC-10 | ☐ |
| 32 | GET `/admin/api/skills/:id` | skill.view | — | 403: ◐；404: ✗ 不存在 → 404 | I-SKL-04, I-RBAC-10 | ☐ |
| 33 | PATCH `/admin/api/skills/:id` | skill.manage | — | 403: ◐；404: ✗；400/边界: ✗；审计: ✗ `skill.update` | I-SKL-04, I-RBAC-10 | ☐ |
| 34 | POST `/admin/api/skills/:id/versions` | skill.manage | — | 403: ◐；404: ✗；400/边界: ✗ 缺 version → 400；重复 → 500；审计: ✗ `skill.version.create` | I-SKL-05, I-SKL-06, I-RBAC-10 | ☐ |
| 35 | GET `/admin/api/tool-sources` | tool.view | F-LEG-10 | 403: ◐；400/边界: ✗ 响应里不能有 `headers` | I-TS-01, I-RBAC-10 | ☐ |
| 36 | POST `/admin/api/tool-sources/import` | tool.manage | F-LEG-10 | 403: ◐；400/边界: ✗ spec 不是 JSON → 400；缺 baseUrl 和 servers → 400；重复 → 409（I-TS-02~04）；审计: ✗ `tool_source.import` | I-TS-02, I-TS-03, I-TS-04, I-RBAC-10 | ☐ |
| 37 | GET `/admin/api/runs` | run.view | S-24、S-25 | 403: ◐；400/边界: ◐ S-25 只测了 `abc`。缺 `0`、`-1`、`1`、`200`、`201`、`1e9`、`1.5`、空串，以及 `status` 过滤（I-RUN-01~03）。`self` 用户只能看到自己的 Run（I-RUN-04） | I-SCOPE-10a, I-RUN-01, I-RUN-02, I-RUN-03, I-RUN-04, I-RBAC-10 | ☐ |
| 38 | GET `/admin/api/runs/:id` | run.view | S-31、I-RBAC-02 | 403: ◐ | I-SCOPE-10a, I-RBAC-10, I-RBAC-11 | ☐ |
| 39 | GET `/admin/api/runs/:id/events` | run.view | — | 403: ◐；404: ✗；400/边界: ✗ | I-RUN-07, I-RUN-08, I-RBAC-10, I-RBAC-11 | ☐ |
| 40 | POST `/admin/api/runs/:id/cancel` | run.cancel | F-LEG-03 | 403: ✗ BL/AU/US 没有 `run.cancel` → 403（I-RUN-05）；404: ✗ 跨部门；400/边界: ✗ 对已结束的 Run 取消也返回 200（I-RUN-06）；审计: ✗ `run.cancel`，已结束的 Run 也会记一条 | I-RUN-05, I-RUN-06, I-RBAC-10, I-RBAC-11 | ☐ |
| 41 | GET `/admin/api/approvals` | approval.view | I-APR-01~07、F-APR-01/07 | 400/边界: ◐ 缺：`page=`（空串）→ 按默认值分页；`page=1e9` → 空 items、total 照常；`pageSize=1e9` → 100；同时有子部门数据时 total 只按自己可见的算（I-APR-30~33） | I-APR-30, I-APR-31, I-APR-32, I-APR-33, I-RBAC-10 | ☐ |
| 42 | POST `/admin/api/approvals/:id/decide` | approval.decide | I-APR-20/21、F-APR-05/06/12、UI-031 | 404: ◐ 见第 6 部分 W-03；400/边界: ✗ 不传 `decision` → 400；不存在的 id 加非法 decision → 404（先查存在再校验参数）；`comment` 超过 1024 → 500；已经过期但还没被清理的审批（I-APR-34~36）；审计: ◐ 写了「有 decide」，建议写全 `approval.decide` 和 `{decision}` | UI-081a/b, UI-034a/b, I-RBAC-02, I-APR-34, I-APR-35, I-APR-36, I-RBAC-10, I-RBAC-11 | ☐ |
| 43 | GET `/admin/api/schedules` | schedule.view | F-LEG-05、I-RBAC-05、I-SCOPE-10 | — | I-SCOPE-10b, I-RBAC-10 | ☐ |
| 44 | GET `/admin/api/schedules/:id` | schedule.view | F-SCH-01~04 | — | I-SCOPE-10b, I-RBAC-10, I-RBAC-11 | ☐ |
| 45 | POST `/admin/api/schedules` | schedule.manage | F-SCH-10 | 403: ◐；404: ✗ agent 不可见 → 404；服务账号属于其他部门 → 404；400/边界: ✗ 不传 agentId、serviceAccountId、cron → 400；agent 未发布 → 400；cron 非法 → 400；时区非法 → 400；服务账号已停用 → 409 SCD-4801；重复 key → 500；`enabled` 传字符串 `"true"` 也是停用（I-SCH-01~08）；审计: ✗ `schedule.create` | F-SCH-10a, I-SCH-01, I-SCH-02, I-SCH-03, I-SCH-04, I-SCH-05, I-SCH-06, I-SCH-07, I-SCH-08, I-SA-10, I-RBAC-10 | ☐ |
| 46 | PATCH `/admin/api/schedules/:id` | schedule.manage | F-SCH-10、S-25 | 403: ◐；404: ✗ 跨部门；400/边界: ✗ cron 非法但不带 status → **直接入库**；`status` 传任意字符串（I-SCH-09/10）；审计: ✗ `schedule.update` 的 details 里有 `input_json` 原值（I-AUD-06） | I-SCOPE-10c, F-SCH-10a, I-AUD-06, I-SCH-09, I-SCH-10, I-SA-10, I-RBAC-10, I-RBAC-11 | ☐ |
| 47 | POST `/admin/api/schedules/:id/enable` | schedule.manage | F-LEG-05、S-27 | 403: ◐；404: ✗ 跨部门；400/边界: ✗ 服务账号已停用 → 409 SCD-4801；库里存的 cron 非法 → 500（接在 I-SCH-09 后面测，I-SCH-11/12） | F-SCH-11b, I-AUD-04, I-SCH-11, I-SCH-12, I-RBAC-10, I-RBAC-11 | ☐ |
| 48 | POST `/admin/api/schedules/:id/disable` | schedule.manage | F-LEG-05、S-27 | 403: ◐；404: ✗ 跨部门 | I-AUD-04, I-RBAC-10, I-RBAC-11 | ☐ |
| 49 | POST `/admin/api/schedules/:id/run` | schedule.run | F-SCH-11~13 | 403: ✗ OP 有 `schedule.run` 但没有 `schedule.manage`，应该能跑；AU → 403（I-SCH-13）；404: ✗ 跨部门；400/边界: ✗ agent 未发布 → 400；存量任务绑的是 PA 服务账号 → **409** SCD-4804；`dataScope=all` 的非 PA 用户能跑其他部门的任务（文档差异 23，I-SCH-14~16） | F-SCH-11c, F-SCH-11a, F-SCH-10b, I-SCH-13, I-SCH-14, I-SCH-15, I-SCH-16, I-RBAC-10, I-RBAC-11 | ☐ |
| 50 | GET `/admin/api/apps/:id/webhook-deliveries` | apikey.view | S-22 | 403: ◐；404: ✗ 应用不存在 → 404 | I-APP-06, I-RBAC-10 | ☐ |
| 51 | POST `/admin/api/webhook-deliveries/:id/replay` | apikey.manage | S-22 | 403: ◐；404: ✗ 不存在 → 404；400/边界: ✗ 调用后会立刻对外投递（要用 mock 接收端）；审计: ✗ `webhook.replay` | I-APP-06, I-RBAC-10 | ☐ |
| 52 | GET `/admin/api/apps` | apikey.view | F-LEG-07、S-22 | 403: ◐；400/边界: ✗ 不能有 secret | I-RBAC-10 | ☐ |
| 53 | POST `/admin/api/apps` | apikey.manage | F-LEG-07 | 403: ✗ BL/OP → 403（只有 OA 有 `apikey.manage`）；400/边界: ✗ 重复 key → 500（不查重）；`scopes` 传任意值都会入库；`rateLimitPerMinute=-1/abc`；`webhookUrl` 是私网地址（I-APP-01~04）；审计: ✗ `app.create` | I-APP-01, I-APP-02, I-APP-03, I-APP-04, I-RBAC-10 | ☐ |
| 54 | PATCH `/admin/api/apps/:id` | apikey.manage | S-22 | 403: ◐；404: ✗ 不存在 → 404；400/边界: ✗ status 改成 disabled 后用 open 接口调用 → **401** 「应用已停用」（文档写的是 403，I-APP-05）；审计: ✗ `app.update`，details 不含 webhookSecret | I-AUD-10, I-APP-05, I-RBAC-10 | ☐ |
| 55 | GET `/admin/api/apps/:id/keys` | apikey.view | F-LEG-07 | 403: ◐；404: ✗ 应用不存在时返回 **200 空数组**，不是 404（I-APP-06） | I-APP-06, I-RBAC-10 | ☐ |
| 56 | POST `/admin/api/apps/:id/keys` | apikey.manage | F-LEG-07、I-SCOPE-04 | 403: ◐；404: ✗ 应用不存在 → 404；400/边界: ✗ 签发的 key 没有过期时间（I-APP-07）；审计: ✗ `apikey.create` | I-APP-07, I-RBAC-10 | ☐ |
| 57 | GET `/admin/api/users` | user.view | F-LEG-08、I-SCOPE-01 | 403: ◐；400/边界: ✗ 响应里有 `idp_subject`、`is_emergency_admin`，需要确认能不能返回（I-USR-01） | I-USR-01, I-RBAC-10 | ☐ |
| 58 | POST `/admin/api/users` | user.manage | S-20、I-RBAC-06 | 400/边界: ✗ 不传 email → 400；email 格式随便填也能建；非法角色 → 400；重复 email → 409；重复 username → 500；密码没有长度要求；`dataScope:"foo"` 也能入库（I-USR-02~06）；审计: ✗ `user.create`，details 不能有密码 | I-AUD-10, I-USR-02, I-USR-03, I-USR-04, I-USR-05, I-USR-06, I-RBAC-10 | ☐ |
| 59 | PATCH `/admin/api/users/:id` | user.manage | S-20/21/28、I-SCOPE-02 | 404: ✗ 不存在 → 404；400/边界: ✗ **不传 dataScope 时会被重置成角色默认值**（只改 status 也会改掉 dataScope）；`status` 传任意字符串；OA 改 PA 但不传 role → 403（I-USR-07~09）；审计: ✗ `user.update`：status 的变化不记；details 里的 dataScope 是请求原值，不传时是空串，和实际写库的值对不上（I-AUD-07） | I-AUD-07, I-USR-07, I-USR-08, I-USR-09, I-RBAC-10 | ☐ |
| 60 | GET `/admin/api/permissions` | role.view | I-RBAC-07 | — | I-RBAC-10 | ☐ |
| 61 | GET `/admin/api/org-units` | org.view | I-DOC-05 | — | I-RBAC-10 | ☐ |
| 62 | GET `/admin/api/role-mappings` | sso.manage | I-RBAC-07 | — | I-RBAC-10 | ☐ |
| 63 | POST `/admin/api/role-mappings` | sso.manage | I-RBAC-07 | 400/边界: ✗ 缺 `agentRoleCode` 或 `localRole` → 400；`localRole:"superuser"` 也能入库（I-USR-10）；审计: ✗ `role_mapping.upsert` 的 details 是整个请求体，resource_id 为空（I-USR-11） | I-AUD-11, I-USR-10, I-USR-11, I-RBAC-10 | ☐ |
| 64 | GET `/admin/api/audit` | audit.view | I-G-08、S-25 | 403: ◐（AU、OA 能看；BL → 403）；400/边界: ◐ 缺 `0`、`1.5`、`abc`、`500`、`501`、`1e9`（I-AUD-08） | I-AUD-08, I-RBAC-10 | ☐ |
| 65 | GET `/admin/api/sso` | sso.manage | I-RBAC-07、F-LEG-09 | — | I-RBAC-10 | ☐ |
| 66 | GET `/admin/api/plugins` | package.view | I-DOC-05 | — | I-RBAC-10 | ☐ |
| 67 | POST `/admin/api/plugins/install` | plugin.install | S-29 | 403: ◐；400/边界: ✗ mcp 缺 url、provider 缺 baseUrl → 400，前面已经建好的资源留在库里；同一个 (key, version) 再装会覆盖；model 重复 → 500（I-PLG-01/02）；审计: ✗ `plugin.install` | I-PLG-01, I-PLG-02, I-RBAC-10 | ☐ |
| 68 | POST `/admin/api/plugins/:id/uninstall` | plugin.uninstall | I-RBAC-07 | 404: ✗ id 不存在也返回 **200**，而且会写审计（I-PLG-03）；审计: ✗ | I-PLG-03, I-RBAC-10 | ☐ |
| 69 | GET `/admin/api/service-accounts` | service_account.manage | I-RBAC-07 | — | I-SA-10, I-RBAC-10 | ☐ |
| 70 | POST `/admin/api/service-accounts` | service_account.manage | I-RBAC-07 | 400/边界: ✗ 不传 name → 400；非法角色 → 400；`dataScope:"self"` → 400；`role:"platform_admin"` → 400 SCD-4804；重复 key → 409（I-SA-01~05）；审计: ✗ `service_account.create` | I-SA-01, I-SA-02, I-SA-03, I-SA-04, I-SA-05, I-RBAC-10 | ☐ |
| 71 | GET `/admin/api/service-accounts/:id` | service_account.manage | — | 404: ✗ 不存在 → 404 | I-SA-09, I-SA-10, I-RBAC-10, I-RBAC-11 | ☐ |
| 72 | PATCH `/admin/api/service-accounts/:id` | service_account.manage | — | 404: ✗；400/边界: ✗ `status:"foo"` → 400；`name:""` 会被忽略（I-SA-06/07）；审计: ✗ 停用时记 `service_account.disable`，否则记 `service_account.update`，details 是 `{before, changes}`（I-SA-08） | I-SA-06, I-SA-07, I-SA-08, I-SA-09, I-RBAC-10, I-RBAC-11 | ☐ |
| 73 | GET `/open/v1/agents` | agents:read | I-OPEN-01/03 | 403: ✗ scope 不够 → 403 POL-2001；400/边界: ✗ 只返回本应用部门可见、`api_enabled` 而且已发布的 agent（I-OPEN-15） | I-OPEN-15 | ☐ |
| 74 | GET `/open/v1/agents/:key` | agents:read | — | 401: ✗；403: ✗；404: ✗ | I-OPEN-10, I-OPEN-11 | ☐ |
| 75 | POST `/open/v1/agents/:key/runs` | runs:create | I-OPEN-03 | 403: ✗ scope；404: ✗；400/边界: ✗ `Idempotency-Key`：同一个键重放 → 200 并带 `Idempotency-Replayed: true`；同键不同请求体 → 409 OPN-4503；长度 201 → 400；日配额 → 429 OPN-4501；每分钟限流 → 429 OPN-4502（I-OPEN-16~20）；审计: ✗ `open.run.create`，actor_type 是 app | I-OPEN-16, I-OPEN-17, I-OPEN-18, I-OPEN-19, I-OPEN-20 | ☐ |
| 76 | POST `/open/v1/agents/:key/invoke` | runs:create | I-OPEN-01 | 403: ✗；404: ✗；400/边界: ✗ `wait` 传 `0`、`121`、`abc`、`1.7`（I-OPEN-21）；审计: ✗ | I-OPEN-21 | ☐ |
| 77 | GET `/open/v1/openapi.json` | 无认证 | I-G-10 | — | — | ☐ |
| 78 | GET `/open/v1/runs/:id` | runs:read | — | 401: ✗；403: ✗；404: ✗ | I-OPEN-12 | ☐ |
| 79 | POST `/open/v1/runs/:id/cancel` | runs:cancel | S-27 | 401: ✗；403: ✗ scope 只有 `runs:read` → 403；404: ✗ 跨应用；400/边界: ✗ Run 已结束 → 200 | I-OPEN-12, I-AUD-04 | ☐ |
| 80 | GET `/open/v1/runs/:id/events` | runs:read | — | 401: ✗；403: ✗；404: ✗ | I-OPEN-13 | ☐ |
| 81 | GET `/open/v1/runs/:id/result` | runs:read | — | 401: ✗；403: ✗；404: ✗；400/边界: ✗ 409 RUN-7002 | I-OPEN-14 | ☐ |
| 82 | GET `/integration/v1/agents` | 无 | S-23、S-34、I-OPEN-04 | 403: ✗ 见 A5 | S-38(引用), I-INT-10, I-INT-01, I-INT-02, I-INT-03, I-INT-04, I-INT-05, I-INT-06, I-INT-12 | ☐ |
| 83 | POST `/integration/v1/runs` | 无 | S-23、S-35、S-36 | 404: ✗ 不存在或未发布 → 404；400/边界: ✗ 不传 `agentKey` → 400（I-INT-07） | I-INT-10, I-INT-07, I-INT-11, I-INT-13, I-AUD-04 | ☐ |
| 84 | GET `/integration/v1/runs/:id` | 无 | I-OPEN-04 | 403: ✗；404: ✗ | I-INT-08 | ☐ |
| 85 | GET `/integration/v1/runs/:id/result` | 无 | I-OPEN-04 | 403: ✗；404: ✗；400/边界: ✗ 409 RUN-7002 | I-INT-09 | ☐ |
| 86 | POST `/integration/v1/runs/:id/cancel` | 无 | S-27、S-36 | 403: ✗；404: ✗ | I-AUD-04 | ☐ |

行数核对：86 条路由（inventory §1.14 计数一致）。
