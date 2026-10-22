# forge 威胁清单（设计层，供用例与安全专家审查）

基线：main（543b664 + 待推 `4c2555e`）。环境：仅 127.0.0.1:3198 / forge_ux。  
**用例映射**：下表「对应用例」列由测试工程师填写；执行前架构师/安全可改预期。

| 组 | 威胁要点 | 对应用例 | 建议严重度 |
|---|---|---|---|
| T1 | Cookie 属性 HttpOnly/SameSite/Secure(生产)/Path；登出服务端作废 | F-AUTH-02, F-AUTH-06, S-02, UI-006 | P0 |
| T1 | 登录前后 session id 变化（防会话固定） | **S-33**（新增） | P1 |
| T1 | CSRF：无/错 token 写接口 403；GET 无副作用 | I-G-04, I-G-05, S-01 | P0 |
| T1 | 停用/改密后旧会话失效 | S-28 | P0（阻断候选） |
| T1 | 登录爆破限流；错误信息不枚举 | S-03, S-04, S-32, Q3 | P0/待确认 |
| T2 | 角色 × 86 路由矩阵 | I-RBAC-01～07, I-G-01, §8.5 执行表 | P0 |
| T2 | org_admin 提权：dataScope=all、改他部用户、动 PA | S-20, S-21, Q2 | **P0 阻断候选** |
| T2 | users/apps/audit/dashboard 是否应按部门过滤 | I-SCOPE-01～05, S-22, Q1 | P0/待确认 |
| T2 | IDOR：runs/approvals/agents/schedules/sa/apps 跨部门 = 不存在 | I-RBAC-02, F-SCH-02, S-12 | P0 |
| T2 | 6 个未分配权限 key 仅 PA | I-DOC-05, I-RBAC-07, Q4 | P1 |
| T3 | PA 服务账号不可绑 SCD-4804；停用→4801；并发 skip 4802 | **F-SCH-10～12**（新增） | P1 |
| T3 | 手动 /run 审计含点击人+执行身份 | **F-SCH-13**（新增） | P1 |
| T4 | 列表 args_preview 打码（59 单测） | I-APR-10, I-APR-11, F-APR-02, UI-032 | P0 |
| T4 | **运行详情工具参数未打码** | S-31, UI-032 | **P0 阻断候选** |
| T4 | 重复决策 409 CFG-8503；过期不可批 | I-APR-21, UI-031, UI-034 | P1 |
| T5 | integration：JWT 无效 401 / 开关关 503；有效但无权限应 403；写审计 | S-23, Q6, **S-34～S-36**（新增） | P1（严重） |
| T5 | API Key 只存哈希；吊销立即生效；Bearer 调 admin → 401 | S-24, I-OPEN-01～02, S-09 | P0 |
| T5 | open cursor 不可篡改越权 | **S-37**（新增，若实现 cursor） | P2 |
| T6 | SQLi / XSS 新旧控制台 | S-05～S-07, UI-022, UI-043 | P0 |
| T6 | limit 非法/坏 JSON/超大 body → 400 非 500；无堆栈 | S-25, S-26, I-G-06～07 | P1 |
| T6 | 安全响应头 | S-10 | P1 |
| T7 | 默认密钥拒绝；日志无秘密（含 query/主动 log） | OPS-001～007, OPS-014, S-09 | 待实测→或 P0 |
| T7 | 3100 HOST=0.0.0.0 | O-11（运维/用户决策） | P1 运维 |
| T7 | 依赖与许可证扫描 | S-13 | P1 |

原始叙述见同目录历史版本 / `~/forge-baseline/threat-model.md`（架构师原稿）。
