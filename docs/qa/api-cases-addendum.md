# 接口用例补充（合入后端审阅 `/tmp/forge-logs/api-cases-review.md`）

> **来源**：后端专家审阅 `b7bfce9`（只读 `4c2555e` 代码，未发请求）。编号按审阅「附：建议新增编号区间」。  
> **口径**：架构师 2026-10-22 定——预期一律写**正确行为**；代码现状不符的标「**已知缺陷**」，执行时如实记 fail，不写「A 或 B 都算通过」。  
> **环境**：默认 `http://127.0.0.1:3198` / `forge_ux`；不碰 3100、开发库 `forge`、`.env`。  
> **通用前置**：所有 `/admin/api` 写请求都带**本会话**的 `X-CSRF-Token`（取自 `GET /auth/session`），否则一律 403 POL-2001，矩阵会整体误判（见 I-CSRF-*）。  
> **列含义**：路由列用 inventory 编号 `#N`；「现状」写进备注。错误码默认带在 `code` 字段。

## 0. 专用前置

| 前置 ID | 内容 |
|---|---|
| PRE-CON | **connector 用例（I-INT-01~13、S-34~36、I-ERR CON-47xx）**：由运维在 **3197** 用临时 `.env` 起独立实例（库另建，非 `forge`/`forge_ux` 共用写入），打开 connector 开关，配置**测试用 RSA 密钥对**。**私钥只放 `/tmp`**（如 `/tmp/forge-qa-con/`，chmod 600），不入库、不进仓库、不贴群；**测完删除私钥与临时 `.env`，停实例**。3197 由谁起：待运维/后端在群里定。 |
| PRE-OIDC | SSO-1204~1211 需 mock OIDC IdP；无 mock 时标「N/A，单测覆盖」并写明单测文件路径 |
| PRE-MOCK | 模型类用 mock 8090（可返回 5xx / 非流式 / 超时）；MCP、webhook 用本机 mock 接收端，不对外网发请求。**统一出站校验后（架构师口径）**：mock 8090 及本机接收端须**显式加入出站白名单**才放行，白名单默认为空（见 S-49）；依赖 mock 的用例前置里写明白名单配置 |
| PRE-ROLE | 角色账号 `~/forge-qa-users.json`（PA/OA/BL/OP/AU/US/OO + 父/子部门用户各一） |
| PRE-TMP | 需要改开关的（`ALLOW_LOCAL_LOGIN=false`、未构建控制台、OIDC issuer 不通）一律用临时端口实例，不改 3198 |

## 1. 完全无用例的 10 条路由

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-PUB-01 | #2 GET `/next` | — | 不跟随重定向请求 | 302，`Location: /next/` | P2 | |
| I-PUB-02 | #3 GET `/next/*` | PRE-TMP：控制台未构建的临时实例 | GET `/next/agents` | 503 text/plain，无堆栈 | P3 | 无法构造则 N/A |
| I-AUTH-01 | #8 GET `/auth/session` | 两种状态 | ① 无 cookie ② 已登录 | ① 401 AUTH-1001 ② 200 含 `user`、`permissions`、`csrfToken`；全文不含 `password_hash` | P0 | |
| I-AUTH-05 | #11 GET `/auth/oidc/callback` | OIDC 已配或 PRE-TMP | 不带 `code`/`state` | 400 SSO-1203 | P1 | 不需要 IdP |
| I-AUTH-06 | #11 同上 | 同上 | `?code=x&state=随便填` | 400 SSO-1203 | P1 | |
| I-RUN-07 | #39 GET `/admin/api/runs/:id/events` | OO 登录；根部门 Run id | ① OO 请求根部门 Run ② 请求不存在 id | 两者均 404 RUN-7001，响应体相同 | P0 | |
| I-RUN-08 | #39 同上 | 本部门 Run 运行中 | ① 带 `Last-Event-ID: abc` ② 等 Run 结束 | ① 按 0 处理，从头回放 ② Run 结束后服务端关闭连接 | P2 | |
| I-OPEN-10 | #74 GET `/open/v1/agents/:key` | 合法 key（`agents:read`） | 请求 `api_enabled=0` 的 Agent；再请求未发布 Agent | 均 404 RUN-7001 | P1 | |
| I-OPEN-11 | #74 同上 | 应用属部门 A | 请求部门 A 看不到的已开放 Agent；另不带 key 请求 | 前者 404；后者 401 | P0 | |
| I-OPEN-12 | #78 GET `/open/v1/runs/:id`、#79 cancel | 应用 A、B 各一 key | A 读 / 取消 B 的 Run；A 用仅 `runs:read` 的 key 调 cancel | 读、取消均 404 RUN-7001；scope 不足 403 POL-2001 | P0 | |
| I-OPEN-13 | #80 GET `/open/v1/runs/:id/events` | 同上 | A 读 B 的 Run 事件；scope 仅 `agents:read` 读自己 Run | 404 RUN-7001；403 POL-2001 | P0 | |
| I-OPEN-14 | #81 GET `/open/v1/runs/:id/result` | 本应用 Run 未结束 | 调 result；跨应用调 | 409 RUN-7002，`details.status` 有值；跨应用 404 | P1 | 覆盖 RUN-7002 |
| I-INT-08 | #84 GET `/integration/v1/runs/:id` | PRE-CON | 映射用户数据范围以外的 Run | 404 RUN-7001 | P0 | |
| I-INT-09 | #85 GET `/integration/v1/runs/:id/result` | PRE-CON | 未结束 Run；范围外 Run | 409 RUN-7002；404 | P1 | |

## 2. CSRF 顺序（I-CSRF）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-CSRF-01 | #14 POST `/admin/api/agents` | AU 会话 | 不带 `X-CSRF-Token` | 403 POL-2001，message「CSRF Token 缺失或无效」，**不是**「角色缺少权限」 | P0 | 证明 CSRF 先于权限 |
| I-CSRF-02 | 同上 | AU 会话 | 带本会话正确 CSRF | 403 POL-2001「角色缺少权限: agent.manage」 | P0 | |
| I-CSRF-03 | 同上 | 无会话 | 不带 cookie、不带 CSRF | 401 AUTH-1001，不是 403 | P0 | |
| I-CSRF-04 | #9 `/auth/logout`、`/open/*`、`/integration/*` | 有凭证 | 不带 CSRF 调写接口 | 不因 CSRF 拒绝（按现设计；记录） | P2 | 设计确认项 |
| I-CSRF-05 | 任一 admin 写接口 | 会话 A、B | A 的 cookie + B 的 csrfToken | 403 POL-2001「CSRF Token 缺失或无效」 | P0 | |

## 3. Integration / Connector（I-INT，全部前置 PRE-CON）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-INT-01 | #82 | 测试私钥签 JWT | `subject` 或 `principalType` 为空 | 401 CON-4701 | P1 | |
| I-INT-02 | #82 | 开关开但不配公钥 | 任意请求 | 503 CON-4702 | P1 | |
| I-INT-03 | #82 | 打开 legacy fallback | 任意请求 | 503 CON-4704 | P2 | |
| I-INT-04 | #82 | — | `environment` 与实例不符 | 401 CON-4705 | P1 | |
| I-INT-05 | #82 | — | `subject` 不在 `users.idp_subject` | 403 CON-4706 | P1 | |
| I-INT-06 | #82 | — | 分别：签名错、过期、iss 错、aud 错、`alg:none`、HS256（公钥当 HMAC 密钥） | 6 次均 401 CON-4707 | P0 | |
| I-INT-07 | #83 POST `/integration/v1/runs` | 合法 JWT | 不传 `agentKey`；传不存在/未发布 key | 400 CFG-8501；404 RUN-7001 | P1 | |
| I-INT-08 | #84 | 见 §1 | | | | |
| I-INT-09 | #85 | 见 §1 | | | | |
| **I-INT-10** | #82、#83（及 #84~#86） | 映射用户有 `idp_subject` | **a.** 用户 `status=disabled`；**b.** 用户已删除（软删/置删除态，`idp_subject` 仍在）；**c.** 用户所属部门已停用。三种情况各调 `GET /integration/v1/agents` 与 `POST /integration/v1/runs` | 三种情况均 **403 CON-4706**，不建 Run | **P0** | **已知缺陷**：`principalForConnector` 不过滤 status，现状 200 / 202。与 **S-45**（会话快照）同类，互相引用 |
| I-INT-10b | #82、#83 | PRE-CON；映射用户正常 | 让主体查库失败（MySQL 断开，同 OPS-024），调 `GET /integration/v1/agents` | 查库失败属基础设施故障：**503**，**不能是 403 CON-4706**；只有确认查到用户且不可用时才 CON-4706 | P0 | 与 S-45b 同口径 |
| I-INT-11 | #83 | 映射用户为 AU（无 `agent.run`） | 建 Run | 403 POL-2001「角色缺少权限: agent.run」 | P1 | **已知缺陷** K-06：现状 202（同 S-35） |
| I-INT-12 | #82 | 映射用户属部门 A | 列 agents | 只含 A 部门子树可见且已发布的 Agent | P1 | **已知缺陷**：现状全局、不看 api_enabled（Q6） |
| I-INT-13 | #83 | 映射用户属部门 A | 建 Run 后 PA 查 `GET /admin/api/runs/:id` | Run 的 org = 部门 A；subject = 映射用户 | P1 | |

## 4. 审计（I-AUD）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-AUD-01 | 全部写路由 | PA | 每个写操作成功后查 `GET /admin/api/audit` | action 与 `route-exec-matrix.md` 的「审计」列逐条一致（inventory §1.15 的 36 个 action） | P1 | 例外见 I-AUD-03/04 |
| I-AUD-02 | #7 本地登录 | — | 成功登录一次；错误密码一次 | 成功写 `auth.login.local`；失败不写 | P1 | |
| I-AUD-03 | #9 POST `/auth/logout` | 已登录 | 退出后查审计 | 应写退出审计 | P2 | **已知缺陷** K-03：现状不写（6 个不写审计接口之一） |
| I-AUD-04 | #47 #48 #79 #83 #86 | — | enable/disable schedule、open cancel、integration 建 Run / cancel | 均应有审计 | P1 | **已知缺陷** K-03（S-27） |
| I-AUD-05 | #28 PATCH mcp | headers 含 `Authorization: Bearer x` | 改 headers 后读审计 details | `headers_json` 中敏感值打码 | P0 | **已知缺陷**：现状明文 |
| I-AUD-06 | #46 PATCH schedule | input 含 `api_key` | 改 input 后读审计 | `input_json` 敏感值打码 | P1 | **已知缺陷**：现状明文 |
| I-AUD-07 | #59 PATCH user | — | 只改 status | 审计记 status 变化；dataScope 记实际写库值 | P2 | **已知缺陷**：status 不记、dataScope 记请求原值 |
| I-AUD-08 | #64 GET audit | AU | `limit` = 0 / 500 / 501 / 1e9 / -1 / 1.5 / abc | 0→空；500/501/1e9→最多 500 条；-1/1.5/abc → 400 CFG-8501 | P2 | **已知缺陷** K-08：后三者现状 500 |
| I-AUD-09 | — | — | 读一条审计行 | 含 IP / UA / traceId（文档要求） | P3 | 文档债：表无此列 |
| I-AUD-10 | #21 #54 #58 | — | provider.create / app.update / user.create 后读 details | 不含 apiKey / webhookSecret / 密码 | P0 | |
| I-AUD-11 | #63 role-mappings | — | upsert 后读审计 | details 不含多余字段；resource_id 非空 | P3 | 现状整个请求体、resource_id NULL |

## 5. 错误码覆盖（I-ERR）

| 编号 | 码 | 路由 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| I-ERR-01 | SSO-1201（403 分支） | #11 | PRE-OIDC | 无映射角色账号登录 | 403 SSO-1201 | P2 |
| I-ERR-02 | SSO-1202 | #10 | PRE-TMP issuer 不通 | `/auth/oidc/login` | 502 SSO-1202 | P2 |
| I-ERR-03 | SSO-1203 | #11 | — | 同 I-AUTH-05/06 | 400 SSO-1203 | P1 |
| I-ERR-04 | SSO-1204 | #11 | PRE-OIDC | 令牌交换失败 | 401 SSO-1204 | P3 |
| I-ERR-05 | SSO-1205 | #11 | PRE-OIDC | 不返回 id_token | 401 SSO-1205 | P3 |
| I-ERR-06 | SSO-1206 | #11 | PRE-OIDC | nonce 不符 | 401 SSO-1206 | P3 |
| I-ERR-07 | SSO-1207 | #11 | PRE-OIDC | 不返回 access_token | 401 SSO-1207 | P3 |
| I-ERR-08 | SSO-1208 | #11 | PRE-OIDC | 两令牌 sub 不一致 | 401 SSO-1208 | P3 |
| I-ERR-09 | SSO-1209 | #11 | PRE-OIDC | sub 为空 | 401 SSO-1209 | P3 |
| I-ERR-10 | SSO-1210 | #11 | PRE-OIDC | 用户无邮箱 | 403 SSO-1210 | P3 |
| I-ERR-11 | SSO-1211 | #11 | PRE-OIDC | 建用户失败 | 500 SSO-1211，无堆栈 | P3 |
| I-ERR-12 | MDL-3001 | #19/#25 | PRE-MOCK 5xx | 跑 Run / test | Run `error_code`=MDL-3001 或 test `ok:false` | P2 |
| I-ERR-13 | MDL-3003 | 同上 | 非流式响应 | 同上 | `error_code`=MDL-3003 | P3 |
| I-ERR-14 | MDL-3004 | 同上 | 超时 | 同上 | `error_code`=MDL-3004 | P2 |
| I-ERR-15 | SYS-9002 | 同上 | 按后端给的触发条件 | 同上 | `error_code`=SYS-9002 | P3 |
| I-ERR-16 | HTP-4002 | 工具调用 | mock 工具上游异常 | Run 结果 | `error_code`=HTP-4002 | P3 |
| I-ERR-17 | BUD-5001 | Run | 预算设极小 | Run 结果 | `error_code`=BUD-5001 | P2 |
| I-ERR-18 | RUN-7004 | Run | 按后端给的触发条件 | Run 结果 | `error_code`=RUN-7004 | P3 |
| I-ERR-19 | OUT-6001 | Run | 输出不符 schema | Run 结果 | `error_code`=OUT-6001 | P3 |
| I-ERR-20 | SCD-4803 | schedule 触发 | 按后端给的触发条件 | Run 结果 | `error_code`=SCD-4803 | P3 |
| I-ERR-21 | MCP-4101 | Run 调 MCP | MCP 工具报错 | Run 结果 | `error_code`=MCP-4101；MCP-4102 代码不产生 → N/A | P3 |
| I-ERR-22 | SCD/CFG（S-25 补） | #46 | — | PATCH cron 非法且不带 status | 400 CFG-8501，不入库 | P1 |

**21 个可从 HTTP 触发但原无用例的错误码 → 用例**：SSO-1201(403)→I-ERR-01 · SSO-1202→I-ERR-02 · SSO-1203→I-ERR-03/I-AUTH-05 · SSO-1204~1209→I-ERR-04~09 · SSO-1210/1211→I-ERR-10/11 · CON-4701/4702/4704/4705/4706/4707→I-INT-01/02/03/04/05/06 · OPN-4501→I-OPEN-19 · OPN-4502→I-OPEN-20 · OPN-4503→I-OPEN-17 · RUN-7002→I-OPEN-14、I-INT-09 · HTP-4001→I-MCP-05。

## 6. 只有泛化用例的路由 → 接口级断言（A1.2 及其余 A2 缺口）

### 6.0 认证补充（I-AUTH-02~04、07~09，#7 #9 #10 #11）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-AUTH-02 | #7 | PRE-TMP `ALLOW_LOCAL_LOGIN=false` | 正确账号登录 | 403 POL-2001 | P1 | |
| I-AUTH-03 | #7 | 一个停用用户 | ① `email` 传数字 / 布尔 ② 停用用户用正确密码 | ① 400 CFG-8501 ② 401 AUTH-1001，文案与密码错误相同 | P0 | |
| I-AUTH-04 | #9 | — | 无会话 POST logout；有会话不带 CSRF POST logout | 均 200 `{ok:true}`（不校验 CSRF，设计确认） | P2 | 审计见 I-AUD-03 |
| I-AUTH-07 | #10 | OIDC 已配 | `returnTo=abc`（不以 `/` 开头） | 回落为 `/` | P2 | `//evil` 见 S-30 |
| I-AUTH-08 | #11 | PRE-OIDC | 成功 OIDC 登录 | 审计 `auth.login.oidc` | P2 | 无 mock IdP 则 N/A |
| I-AUTH-09 | #7 | 一个用户，其所属部门已停用 | 用正确密码本地登录 | **401 AUTH-1001**，与密码错误时表现完全相同（状态码、错误码、文案） | P0 | 修复 F；与 S-45 同口径 |

### 6.1 Agent（I-AGT，#14~#19）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-AGT-01 | #14 | BL | key = `a` / `ab` / 64 位 / 65 位 / `Ab` / `-ab` | 400 / 200 / 200 / 400 / 400 / 400 | P1 | |
| I-AGT-02 | #14 | 已有 key | 同 key 再建 | 409 CFG-8503 | P1 | |
| I-AGT-03 | #14 | — | 并发两个同 key 请求 | 一个 200，一个 409 CFG-8503 | P2 | **已知缺陷候选**：静态推断可能 500 |
| I-AGT-04 | #14 | — | `spec` 传坏 JSON 字符串 | 400 CFG-8501 | P2 | **已知缺陷**：现状静默用默认 spec |
| I-AGT-05 | #16 | — | `status:"foo"`；`status` 17 字符 | 400 CFG-8501 | P2 | **已知缺陷**：现状入库 / 500 |
| I-AGT-06 | #17 | — | 不传 `version` | 400 CFG-8501 | P1 | |
| I-AGT-07 | #17 | — | 同 agent 重复 version | 409 CFG-8503 | P2 | **已知缺陷**：现状 500 |
| I-AGT-08 | #18 | — | 不传 `versionId` | 400 CFG-8501 | P1 | |
| I-AGT-09 | #18 | 两个 agent | `versionId` 属于另一 agent；OO 发布根部门 agent | 404「版本不存在」；404「Agent 不存在」 | P0 | |
| I-AGT-10 | #19 | 有草稿版本 | `versionId` = 草稿 | 400 CFG-8501（不得跑草稿） | P2 | **已知缺陷候选**，待架构师确认；现状 200 |
| I-AGT-11 | #19 | agent `status=disabled` | 试运行 | 400/409 拒绝（码待后端定，执行前写死） | P1 | **已知缺陷**：现状可跑 |
| I-AGT-12 | #19 | — | 无可用版本；`threadId` 属他人；OO 跑根部门 agent | 400「Agent 没有可用版本」；404「会话不存在」；404「Agent 不存在」 | P1 | 审计 `run.create` |

### 6.2 模型（I-MDL，#20~#25）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-MDL-01 | #20 | provider 有 apiKey | GET providers | 响应无 `apiKey` 字段/值 | P0 | |
| I-MDL-02 | #21 | — | 缺 key；缺 baseUrl | 400 CFG-8501 | P1 | |
| I-MDL-03 | #21 | — | 重复 key | 409 CFG-8503 | P1 | |
| I-MDL-04 | #21 | — | `timeoutMs:"abc"` | 400 CFG-8501 | P2 | **已知缺陷**：现状 500 |
| I-MDL-05 | #22 | — | provider 不存在；同 provider 重复 model key | 404「Provider 不存在」；409 CFG-8503 | P2 | 后者**已知缺陷**：现状 500 |
| I-MDL-06 | #22 | — | `contextWindow:"abc"` | 400 CFG-8501 | P2 | 现状 NaN 入库，执行记录 |
| I-MDL-07 | #23 | provider 有 key | PATCH `apiKey:""` 后 test | 200；原 key 保留，test 仍可用 | P1 | |
| I-MDL-08 | #23/#24 | — | 不存在 id | 404 RUN-7001；成功时审计 `provider.update`/`model.update` | P2 | |
| I-MDL-09 | #25 | provider 无模型 | test | 400「Provider 还没有模型」；不存在 id → 404 | P2 | |
| I-MDL-10 | #25 | PRE-MOCK 上游不通 | test | 200 `ok:false`；`error` 不含内网地址、apiKey | P1 | |

### 6.3 MCP（I-MCP，#26~#29）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-MCP-01 | #26 | MCP 有 headers | GET mcp | 无 `headers` | P0 | |
| I-MCP-02 | #27 #29 | 出站白名单为空（默认） | create 与 refresh 各一次，url 依次为回环 `http://127.0.0.1:…`、私网、链路本地、云元数据 `http://169.254.169.254/` | **拦截，返回明确错误码**（统一出站校验，与 S-39 / S-46 同码），不发起连接 | P1 | **已知缺陷**（SSRF）：现状不拦。DNS rebinding 见 S-48，8090 白名单见 S-49 |
| I-MCP-03 | #27 | — | 缺 url；重复 key | 400；409 | P1 | |
| I-MCP-04 | #28 | — | 不存在 id；成功改名 | 404「MCP 不存在」；审计 `mcp.update` | P2 | 敏感值见 I-AUD-05 |
| I-MCP-05 | #29 | PRE-MOCK 上游 500 | refresh | 502 HTP-4001 | P1 | |
| I-MCP-06 | #29 | 上游连不上 | refresh | 502 HTP-4001 | P2 | **已知缺陷**：现状 500 SYS-9001 |
| I-MCP-07 | #29 | — | 不存在 id | 404 RUN-7001 | P2 | |
| I-MCP-08 | #27 | — | 创建成功；发现失败 | 审计 `mcp.create`；`warning` 不含内网地址/密钥 | P2 | 与 S-26 |

### 6.4 Skill（I-SKL，#30~#34）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-SKL-01 | #31 | — | 缺 key | 400 CFG-8501 | P2 | |
| I-SKL-02 | #31 | — | 重复 key | 409 CFG-8503 | P2 | |
| I-SKL-03 | #31 | — | 不传 `publish` | 200，默认已发布；审计 `skill.create` | P3 | 记设计 |
| I-SKL-04 | #32/#33 | — | 不存在 id GET / PATCH | 404「Skill 不存在」 | P2 | |
| I-SKL-05 | #34 | — | 缺 version | 400 CFG-8501 | P2 | |
| I-SKL-06 | #34 | — | 重复 version | 409 CFG-8503 | P2 | **已知缺陷**：现状 500 |

### 6.5 工具源（I-TS，#35~#36）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-TS-01 | #35 | 有 headers | GET | 无 `headers` | P0 | |
| I-TS-02 | #36 | — | spec 非 JSON | 400「spec 必须是 OpenAPI JSON」 | P2 | |
| I-TS-03 | #36 | — | 无 baseUrl 且无 servers | 400「缺少 baseUrl 或 servers[0].url」 | P2 | |
| I-TS-04 | #36 | — | 重复 key | 409 CFG-8503；成功时审计 `tool_source.import` | P2 | |

### 6.6 Run（I-RUN，#37~#40）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-RUN-01 | #37 | ≥201 条 Run | `limit` = 0 / -1 / 1 / 200 / 201 / 1e9 / 空串 | 1 / 1 / 1 / 200 / 200 / 200 / 1 条 | P2 | |
| I-RUN-02 | #37 | — | `limit` = abc / 1.5 | 400 CFG-8501 | P1 | **已知缺陷** K-08：现状 500 |
| I-RUN-03 | #37 | — | `status=succeeded`；`status=foo` | 仅 succeeded；空列表 | P2 | |
| I-RUN-04 | #37 | US（self） | 列 runs | 只含本人发起 | P0 | |
| I-RUN-05 | #40 | BL/AU/US（带 CSRF） | cancel | 403「角色缺少权限: run.cancel」 | P0 | |
| I-RUN-06 | #40 | 已结束 Run | cancel | 409（不可取消），状态不变，不写审计 | P3 | **已知缺陷候选**：现状 200 且记审计 |
| I-RUN-07 | #39 | 见 §1 | | | | |
| I-RUN-08 | #39 | 见 §1 | | | | |

### 6.7 审批补充（I-APR-30~36，#41~#42）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-APR-30 | #41 | — | `page=`（空串） | 按默认分页 | P2 | |
| I-APR-31 | #41 | — | `page=1e9` | items 空，total 照常 | P2 | |
| I-APR-32 | #41 | — | `pageSize=1e9` | 夹到 100 | P2 | |
| I-APR-33 | #41 | 子部门也有待审 | OA（父）/ 子部门 OP 各查 | total 只计各自可见 | P1 | |
| I-APR-34 | #42 | — | 不传 decision；`comment` 1025 字 | 400 CFG-8501（两者） | P1 | 后者**已知缺陷**：现状 500 |
| I-APR-35 | #42 | — | 不存在 id + 非法 decision | 404（先查存在） | P2 | |
| I-APR-37 | #42 | 审批已 `rejected` | 再调 decide `{"decision":"approved"}` | 409 CFG-8503，状态仍 rejected，Run 不继续 | P1 | 与 I-APR-21 对称（架构师横向 a） |
| I-APR-38 | #40 #42 | Run 处于 waiting_approval，对应审批 pending | ① cancel 该 Run ② 查审批列表 / 详情 ③ decide approved | ② 审批不可操作（不在待审或按钮不可用）③ **409**，Run 保持 cancelled、不执行工具 | P1 | 架构师横向 b；错误码执行前后端写死；现状待实测 |
| I-APR-36 | #42 | 审批已过 `expires_at` 但未被 `timeoutApprovals` 清理 | 批准 | 409 CFG-8503，不批准 | P1 | **已知缺陷**：现状 200（`decideApproval` 不看 expires_at）。UI-034b / UI-081b |

### 6.8 定时任务接口级（I-SCH，#45~#49）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-SCH-01 | #45 | — | 分别不传 agentId / serviceAccountId / cron | 400 CFG-8501 | P1 | |
| I-SCH-02 | #45 | agent 未发布 | 创建 | 400 CFG-8501 | P1 | |
| I-SCH-03 | #45 | — | cron 非法 | 400 CFG-8501 | P1 | |
| I-SCH-04 | #45 | — | timezone 非法 | 400 CFG-8501 | P2 | |
| I-SCH-05 | #45 | 服务账号停用 | 创建 | 409 SCD-4801 | P1 | |
| I-SCH-06 | #45 | — | 重复 key | 409 CFG-8503 | P2 | **已知缺陷**：现状 500 |
| I-SCH-07 | #45 | — | `enabled:"true"`（字符串） | 400 CFG-8501（类型错误） | P3 | 现状静默停用 |
| I-SCH-08 | #45 | OO | agentId 为根部门 agent；serviceAccountId 为他部门 SA | 均 404，同不存在 | P0 | |
| I-SCH-09 | #46 | — | PATCH cron 非法、不带 status | 400 CFG-8501，不入库 | P1 | **已知缺陷**：现状直接入库（= I-ERR-22） |
| I-SCH-10 | #46 | — | `status:"foo"` | 400 CFG-8501 | P2 | **已知缺陷**：现状入库 |
| I-SCH-11 | #47 | SA 停用 | enable | 409 SCD-4801，状态不变 | P1 | = F-SCH-11b |
| I-SCH-12 | #47 | 接 I-SCH-09 库里 cron 非法 | enable | 400 CFG-8501 | P2 | **已知缺陷**：现状 500 |
| I-SCH-13 | #49 | OP（有 schedule.run 无 manage）；AU | 手动 run | OP 200；AU 403「角色缺少权限: schedule.run」 | P1 | |
| I-SCH-14 | #49 | agent 未发布 | 手动 run | 400「Agent 尚未发布」 | P2 | |
| I-SCH-15 | #49 | 存量任务绑 PA SA | 手动 run | 409 SCD-4804 | P1 | = F-SCH-10b |
| I-SCH-16 | #49 | 非 PA、dataScope=all 用户 | run 他部门任务 | 200（代码按 dataScope 放行） | P2 | 文档差异 23，记文档债 |

### 6.9 开放平台管理（I-APP，#50~#56）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-APP-01 | #53 | OA | 重复 app key | 409 CFG-8503 | P2 | **已知缺陷**：现状 500；BL/OP 建 app → 403 |
| I-APP-02 | #53 | — | `scopes:["foo"]` | 400 CFG-8501 | P2 | **已知缺陷**：现状入库 |
| I-APP-03 | #53 | — | `rateLimitPerMinute` = -1 / abc | 400 CFG-8501 | P2 | |
| I-APP-04 | #53 | — | `webhookUrl` 私网地址 | 400 | P1 | 转安全专家（SSRF） |
| I-APP-05 | #54 | app 已停用 | 用其 key 调 open | 401「应用已停用」（代码口径） | P2 | 文档写 403，记文档债 |
| I-APP-06 | #55 #50 #51 | — | 不存在 app 的 keys / webhook-deliveries；replay 不存在投递 | 均 404 | P2 | #55 **已知缺陷**：现状 200 空数组 |
| I-APP-07 | #56 | — | 签发 key | 响应 `{id,key,prefix,warning}`，明文仅一次；审计 `apikey.create` | P2 | 无过期时间，记文档债 |

### 6.10 用户 / SSO（I-USR，#57~#63）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-USR-01 | #57 | OA | GET users | 无 `password_hash`；`idp_subject`/`is_emergency_admin` 是否可返回待架构师确认 | P1 | |
| I-USR-02 | #58 | — | 不传 email；email=`abc` | 400；400 | P1 | 后者**已知缺陷**：现状 200 |
| I-USR-03 | #58 | — | 非法 role；重复 email | 400；409「邮箱已存在」 | P1 | |
| I-USR-04 | #58 | — | 重复 username | 409 CFG-8503 | P2 | **已知缺陷**：现状 500 |
| I-USR-05 | #58 | — | password=`1` | 400（最小长度） | P2 | **已知缺陷**：无长度要求 |
| I-USR-06 | #58 | — | `dataScope:"foo"` | 400 CFG-8501 | P1 | **已知缺陷**：现状入库 |
| I-USR-07 | #59 | 用户 dataScope=all | 只 PATCH status | dataScope 保持 all | P1 | **已知缺陷**：现状重置为角色默认 |
| I-USR-08 | #59 | — | `status:"foo"`；不存在 id | 400；404「用户不存在」 | P2 | 前者**已知缺陷** |
| I-USR-09 | #59 | OA | PATCH PA、不传 role | 403「不能授予该角色」 | P1 | 业务 403，不计入 I-RBAC 判定 |
| I-USR-10 | #63 | PA | 缺 agentRoleCode/localRole；`localRole:"superuser"` | 400；400 | P2 | 后者**已知缺陷**：现状入库 |
| I-USR-11 | #63 | — | upsert 后读审计 | 见 I-AUD-11 | P3 | |

### 6.11 插件 / 服务账号（I-PLG，I-SA，#66~#72）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-PLG-01 | #67 | — | resources 中 mcp 缺 url（前面 agent 合法） | 400，且之前资源回滚、无残留 | P1 | **已知缺陷**（S-29）：现状残留且无审计 |
| I-PLG-02 | #67 | — | 同 (key,version) 再装；model key 重复 | upsert 行为记录；重复 model → 409 | P2 | 后者**已知缺陷**：现状 500 |
| I-PLG-03 | #68 | PA | uninstall 不存在 id | 404，不写审计 | P2 | **已知缺陷**：现状 200 且写审计 |
| I-SA-01 | #70 | PA | 不传 name | 400 CFG-8501 | P2 | |
| I-SA-02 | #70 | — | 非法 role | 400 CFG-8501 | P2 | |
| I-SA-03 | #70 | — | `dataScope:"self"` | 400 CFG-8501 | P2 | |
| I-SA-04 | #70 | — | `role:"platform_admin"` | 400 SCD-4804 | P1 | |
| I-SA-05 | #70 | — | 重复 key | 409 CFG-8503；成功审计 `service_account.create` | P2 | |
| I-SA-06 | #72 | — | `status:"foo"` | 400 CFG-8501 | P2 | |
| I-SA-07 | #72 | — | `name:""` | 200，name 不变 | P3 | |
| I-SA-08 | #72 | — | 停用；改名 | 审计分别为 `service_account.disable` / `service_account.update`，details `{before,changes}` | P2 | |
| I-SA-09 | #71 #72 | OO | GET/PATCH 根部门 SA；不存在 id | 均 404「服务账号不存在」，响应体相同 | P0 | |
| I-SA-10 | #45/#46（经 R-sa）、#69/#71 | 父部门 OA；子部门、兄弟部门、上级部门各一个 SA（服务账号接口仅 PA 可调，故经定时任务绑定间接验证 R-sa） | **正**：父部门 OA 创建/PATCH schedule 绑定子部门 SA；**反**：绑定兄弟部门 SA、上级部门 SA | 正：**200**（统一规则：本部门 + 所有子部门）；反：**404**，与 SA 不存在完全相同（状态码、错误码、message），响应不出现账号名 | P1 | 正向**已知缺陷**：R-sa 精确等于，现状 404（修复 D 已改）。= I-SCOPE-10c |

### 6.12 Open 补充（I-OPEN-15~21）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-OPEN-15 | #73 | — | 列 agents；scope 不含 `agents:read` | 只含本应用部门可见、api_enabled、已发布；403 POL-2001 | P1 | |
| I-OPEN-16 | #75 | — | 同 Idempotency-Key 同体重放 | 200，头 `Idempotency-Replayed: true` | P1 | |
| I-OPEN-17 | #75 | — | 同键不同请求体 | 409 OPN-4503 | P1 | |
| I-OPEN-18 | #75 | — | Idempotency-Key 长 201 | 400「Idempotency-Key 过长」 | P2 | |
| I-OPEN-19 | #75 | `dailyQuota=1` | 调两次 | 第二次 429 OPN-4501 | P1 | |
| I-OPEN-20 | #75 | `rateLimitPerMinute=2` | 1 分钟内调三次 | 第三次 429 OPN-4502 | P1 | |
| I-OPEN-21 | #76 | — | `wait` = 0 / 121 / abc / 1.7；Run 已结束 vs 未结束 | 夹到 1 / 120 / 30 / 取整；结束 200、未结束 202 | P2 | 审计 `open.run.create` |

## 7. 文档与代码不一致（I-DOC-10~45，一处一条）

统一预期：**按代码行为判 pass，差异记「文档债」**；标「缺陷」的按缺陷处理。

| 编号 | 底稿 # | 内容 | 步骤 / 预期 | P |
|---|---|---|---|---|
| I-DOC-10 | 1 | `/admin/v1` vs `/admin/api`；`/me` | GET `/admin/api/me`、`/admin/v1/agents` → 404 | P3 |
| I-DOC-11 | 2 | 管理接口 Bearer | 同 S-24：401 AUTH-1001 | P1 |
| I-DOC-12 | 3 | Cookie Secure | 同 S-02 | P1 |
| I-DOC-13 | 4 | 审计含 IP/UA/traceId | 同 I-AUD-09 | P3 |
| I-DOC-14 | 5 | `X-Request-Id` 响应头 | 任意请求查头；无则文档债 | P3 |
| I-DOC-15 | 6 | 错误无 `remedy`；500 无 `details` | 触发 400 与 500 各一 | P3 |
| I-DOC-16 | 7 | 413/415/422 | 见 I-G-06/07；`Content-Type: text/plain` POST → 目标 415 | P2 |
| I-DOC-17 | 8 | 201 vs 200 | 同 I-DOC-03（例外已补全） | P2 |
| I-DOC-18 | 9 | If-Match / revision | 带 `If-Match` 不生效 | P3 |
| I-DOC-19 | 10 | Idempotency-Key 只有 open | admin POST 带该头无效果 | P3 |
| I-DOC-20 | 11 | 分页只有 approvals | runs/agents 带 page 无效 | P3 |
| I-DOC-21 | 12 | `q`/`sort` | `?q=x` 结果与不传相同 | P3 |
| I-DOC-22 | 13 | 无 DELETE | DELETE 任一资源 → Fastify 原生 404 | P3 |
| I-DOC-23 | 14 | 建版本权限是 agent.publish | 内置角色测不出，记文档债 | P3 |
| I-DOC-24 | 15 | users 权限 key | 对照 inventory §3 | P3 |
| I-DOC-25 | 16 | 6 个仅 PA 的 key | 同 I-DOC-05 | P1 |
| I-DOC-26 | 17 | Webhook 权限 key | 对照 apikey.* | P3 |
| I-DOC-27 | 18 | audit 路径 | 实际 `/admin/api/audit` | P3 |
| I-DOC-28 | 19 | 应用停用 401 vs 403 | 同 I-APP-05 | P2 |
| I-DOC-29 | 20 | 部门范围全局 | 同 I-SCOPE-01~05（K-05） | P0 |
| I-DOC-30 | 21 | apps 全局 | 同 S-22 | P0 |
| I-DOC-31 | 22 | R-sched/R-sa 精确等于 | 同 I-SCOPE-10b/10c（统一规则下为缺陷） | P1 |
| I-DOC-32 | 23 | 手动 run 按 dataScope=all 放行 | 同 I-SCH-16 | P2 |
| I-DOC-33 | 24 | `approve`/409/APR-2102；超时 | 同 I-APR-20/21/36 | P1 |
| I-DOC-34 | 25 | Run 详情原样返回参数 | 同 S-31 | P0 |
| I-DOC-35 | 26 | schedule 审计不记前后值 | update 只记新值；enable/disable 不记（I-AUD-04） | P2 |
| I-DOC-36 | 27 | SCD-4804 400 vs 409 | 同 F-SCH-10a/10b | P1 |
| I-DOC-37 | 28 | GET schedule 404 | 同 F-SCH-02/03 | P1 |
| I-DOC-38 | 29 | key 响应字段、无过期 | 同 I-APP-07 | P2 |
| I-DOC-39 | 30 | 插件 dryRun、不回滚、uninstall 200 | 同 I-PLG-01/03 | P2 |
| I-DOC-40 | 31 | MCP 路径 | 实际 `/admin/api/mcp` | P3 |
| I-DOC-41 | 32 | 工具源路径 | 实际 `/admin/api/tool-sources` | P3 |
| I-DOC-42 | 33 | 模型路径 | 实际 `/admin/api/providers`、`/models/:id` | P3 |
| I-DOC-43 | 34 | 组织路径 | 实际 `/admin/api/org-units` | P3 |
| I-DOC-44 | 35 | secrets 路径 | 代码无 secrets 路由 → 404 | P3 |
| I-DOC-45 | 36 | 错误码两边对不上 | 「代码有文档无」：SCD-4802、CON-47xx 等列入报告（补 I-DOC-04 另一半） | P2 |

## 8. 权限矩阵与跨部门（I-RBAC-10~11）

| 编号 | 路由 | 前置 | 步骤 | 预期 | 优先级 | 备注 |
|---|---|---|---|---|---|---|
| I-RBAC-10 | 全部 admin 路由（#12~#72） | PRE-ROLE；写请求带本会话 CSRF | 7 角色各调一次 | 角色**无**该路由权限 key（`route-exec-matrix.md`「权限」列 × inventory §3）→ 403 「角色缺少权限: <key>」；**有** → 不出现该 message（业务 403 如「不能授予该角色」不算） | P0 | 展开为 86 × 7 执行表 |
| I-RBAC-11 | 所有 R-xxx `:id` 路由：#15~#19、#38~#40、#42、#44、#46~#49、#71、#72 | OO 账号；根部门对象 id | 逐条请求根部门 id 与随机不存在 id | 一律 404，错误码与 message 与「不存在」完全相同，不露名称/id | P0 | #42 现状文案「Run 不存在」→ **已知缺陷**（见 I-RBAC-02） |
