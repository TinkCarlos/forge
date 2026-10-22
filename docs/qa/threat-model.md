# forge 威胁清单（设计层，供用例与安全专家审查）

基线：main（543b664 + 待推 `4c2555e`）。环境：仅 127.0.0.1:3198 / forge_ux。  
**用例映射**：下表「对应用例」列由测试工程师填写；执行前架构师/安全可改预期。

| 组 | 威胁要点 | 对应用例 | 建议严重度 |
|---|---|---|---|
| T1 | Cookie 属性 HttpOnly/SameSite/Secure(生产)/Path；登出服务端作废 | F-AUTH-02, F-AUTH-06, S-02, UI-006 | P0 |
| T1 | 登录前后 session id 变化（防会话固定） | **S-33**（新增） | P1 |
| T1 | CSRF：无/错 token 写接口 403 POL-2001；先于权限检查；GET 无副作用 | I-G-04, I-G-05, S-01, I-CSRF-01～05 | P0 |
| T1 | 停用/改密后旧会话失效 | S-28（已知缺陷 K-04）, S-38 | P0（阻断候选） |
| T1 | 登录爆破限流；错误信息不枚举 | S-03, S-04, S-32, Q3 | P0/待确认 |
| T1 | 会话登录时快照角色/部门/数据范围（`packages/identity` 内存 Map，8h）：用户停用、降级、换部门后旧会话仍按原权限放行 → 应下一次请求即生效（401 或新权限） | **S-38**（新增，与 I-INT-10 互引；已知缺陷） | P0 候选 |
| T2 | 角色 × 86 路由矩阵 | I-RBAC-01～07, I-RBAC-10, I-G-01, `route-exec-matrix.md` | P0 |
| T2 | org_admin 提权：dataScope=all、改他部用户、动 PA | S-20, S-21, Q2 | **P0 阻断候选** |
| T2 | users/apps/audit/dashboard 是否应按部门过滤 | I-SCOPE-01～05, S-22, Q1 | P0/待确认 |
| T2 | IDOR：runs/approvals/agents/schedules/sa/apps 跨部门 = 不存在 | I-RBAC-02, I-RBAC-11, F-SCH-02, S-12, I-SA-09 | P0 |
| T2 | 6 个未分配权限 key 仅 PA | I-DOC-05, I-RBAC-07, Q4 | P1 |
| T3 | PA 服务账号不可绑 SCD-4804；停用→4801；并发 skip 4802 | **F-SCH-10a/b、11a～c、12** | P1 |
| T3 | 手动 /run 审计含点击人+执行身份 | **F-SCH-13**（新增） | P1 |
| T4 | 列表 args_preview 打码（59 单测） | I-APR-10, I-APR-11, F-APR-02, UI-032 | P0 |
| T4 | **运行详情工具参数未打码** | S-31, UI-032 | **P0 阻断候选** |
| T4 | 重复决策 409 CFG-8503；过期不可批 | I-APR-21, I-APR-36, UI-031, UI-034a/b, UI-081a/b | P1 |
| T5 | integration：JWT 无效 401 / 开关关 503；有效但无权限应 403；写审计 | S-23, Q6, S-34～S-36, I-INT-11～13 | P1（严重） |
| T5 | Connector JWT 映射用户 **a. 已停用 / b. 已删除 / c. 所属部门已停用** 仍可访问（`principalForConnector` 未过滤 status）→ 三种均应 403 CON-4706；现状 200/202 | **I-INT-10**（覆盖 a/b/c；与 S-38 互引）, I-INT-01～13 | P0 候选 |
| T5 | API Key 只存哈希；吊销立即生效；Bearer 调 admin → 401 | S-24, I-OPEN-01～02, S-09 | P0 |
| T5 | open cursor 不可篡改越权 | **S-37**（新增，若实现 cursor） | P2 |
| T6 | SQLi / XSS 新旧控制台 | S-05～S-07, UI-022, UI-043 | P0 |
| T6 | limit 非法/坏 JSON/超大 body → 400 非 500；无堆栈 | S-25, S-26, I-G-06～07 | P1 |
| T6 | 安全响应头 | S-10 | P1 |
| T7 | 默认密钥拒绝；日志无秘密（含 query/主动 log） | OPS-001～007, OPS-014, S-09 | 待实测→或 P0 |
| T7 | 3100 HOST=0.0.0.0 | O-11（运维/用户决策） | P1 运维 |
| T7 | 依赖与许可证扫描 | S-13 | P1 |

原始叙述见同目录历史版本 / `~/forge-baseline/threat-model.md`（架构师原稿）。
