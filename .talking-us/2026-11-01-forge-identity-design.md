# 账号生命周期与操作日志开发设计

需求：[U01/U02/U05 与 D01–D04](20261031-233358-账号权限三方API与群通知-详细需求文档.md)。这是可独立验收的第一个增量；U03/U04/U06/U07/U08继续保留，不以本增量完成代替全部功能完成。

## 1. 现状依据与边界

- READ：`identity/src/index.ts` 的会话只存用户ID，每请求重新读取账号/部门链；因此角色变更不用同步Cookie。`createAuthSession` 原来不锁用户，存在密码核验→重置→创建会话的竞争，必须补。
- READ：`store/configuration-revision.ts` 已支持同连接事务、CAS与审计；复用它，不再造版本机制。原账号创建与密码/绑定写入未包含审计事务。
- READ：users已有status、唯一username/email/idp_subject；保留行并标deleted足以保存历史ID，释放登录标识不必修改运行归属或删除历史行。所有普通列表/详情排除deleted。
- READ：现有org范围为子树，当前增量保持；精确org、org_tree迁移与角色/数据策略在U03/U04另一个增量实现，不能混淆。此增量只允许将账号分配到当前操作者可管理的有效部门。
- READ：当前只有一个部署配置的OIDC issuer；绑定新增持久化idp_issuer，与验签后的issuer和sub共同校验。旧绑定idp_issuer=NULL时OIDC失败关闭，由管理员重新明确绑定；Connector沿用自身签名主体映射。部署修改issuer不能命中旧issuer相同sub。多IdP不是本次新增范围。issuer与subject均使用utf8mb4_0900_bin精确比较（包括大小写与尾空格）；不沿用登录标识的ci排序规则。旧subject列迁移到该排序规则，原有唯一值保留。

## 2. 账号事实与事务

登录标识先trim，大小写沿MySQL现有排序规则；用户名/邮箱/显示名分别1–64/1–255/1–128字符，拒绝控制字符。新密码8–256字符、原值不trim。邮箱保持现有语法。保留`__deleted__`用户名与`@deleted.forge.invalid`邮箱命名空间，普通输入拒绝占用。

复用settings键`identity.account-lock`作为账号变更的事务互斥行。创建、资料/角色/状态/部门修改、删除、密码变更、SSO绑定均按：锁互斥行→锁目标用户→核对当前状态/CAS/授权→写入→审计→提交。通过ODKU空更新直接获取排它锁，避免INSERT IGNORE共享锁升级死锁。该行只序列化低频账号管理，不锁整个请求或外部调用。哈希计算与OIDC网络访问放在事务外。

- 每次更新在锁内再次以当前行检查组织/角色管理上限，避免读完目标后被另一个管理员移动/提权。账号管理的操作者也在锁内重新读取有效权限与范围；旧请求不可沿用已经撤回的管理权。重置/设置密码、改登录标识、解绑等接管操作即使不传role，也须检查目标当前权限与数据范围不超出操作者，不能接管本部门里被授予all的账号。
- 账号创建与编辑在锁内检查username/email交叉占用，防止某人的用户名等于另一人的邮箱造成歧义；旧库已有歧义时登录查询最多2行，统一认证失败，交管理员修改，不任取第一行。
- 删除：CAS后status=deleted、password_hash=NULL、用户名=`__deleted__`+ID、邮箱=ID+`@deleted.forge.invalid`；若旧库存在排序等价占用，在同锁内选择随机唯一墓碑，普通输入按数据库ci/ai规则拒绝占用命名空间；保留ID、显示名、原SSO subject；立即删除所有auth_sessions。原登录标识与授权快照只写删除审计，正常接口不展示已删除账号。新建同名/邮箱得到新ID，不修改旧Run/Thread/日志的主体ID。
- 最后管理员：任何撤销/停用/删除platform_admin或将其移入不可用部门的操作，提交前在相同互斥行锁下查询剩余active、部门链active、且当前已启用渠道下至少有有效本地密码或issuer匹配SSO绑定的platform_admin；不得少于1。并发撤销按互斥锁顺序执行，后者409；不使用事务外count。移除最后SSO登录能力的解绑/重绑也执行相同保护；组织停用/移动的同类保护归U04复用此锁。
- 修改邮箱/用户名/部门、角色、状态以及改密/重置/绑定/解绑/撤销会话均增加revision。停用、删除、密码变化、绑定变化和显式撤销立即删全部会话；其它授权变化由下一请求实时读取。
- 身份认证产生的Principal带内部authenticationRevision；创建登录会话时锁用户并对比该revision及active状态。先创建的会话会被重置删除，重置后才创建的旧认证结果因版本不同拒绝。普通会话API不返回该内部字段；/auth/session公开user.revision供本人改密表单构造If-Match。
- 已连接SSE每500ms轮询前重新认证和校验Run访问范围（不复用首次请求的会话缓存）；撤销/停用/改密或权限变化后下一轮结束连接，不继续读事件。开放API同样重查Key/App及有效scope，轮询不重复消耗请求额度；轮询串行，不重叠。已完成授权的在途批次可结束，不能声称跨进程瞬时撤回已发出的数据。
- 本人改密：当前密码核验，使用核验时revision执行CAS写密码并撤销全部会话，响应后清Cookie；SSO-only无当前密码不能走本人改密，需管理员先设密码。管理员重置不要求旧密码，必须有user.manage和目标范围，平台管理员保护仍适用。

## 3. SSO与本地并行

`SSO_MODE=required`仍表示生产必须提供受校验的SSO渠道；`ALLOW_LOCAL_LOGIN=true`明确允许所有有本地密码的有效账号并行登录，不再解释为仅应急管理员。SSO签名、必需nonce/ID Token sub、精确issuer/audience、Principal的sub/subject主体对齐必须校验；禁用渠道回调也拒绝。

回调先验签与显式角色映射作为SSO渠道准入，再按sub查已绑定用户：

1. 已绑定且active/部门链有效：返回当前本地授权，不改role、data_scope、org、display_name或password。
2. 已绑定deleted/disabled/部门失效：拒绝，不创建新账号、不按邮箱找替代账号。
3. 未绑定：同邮箱或用户名被本地账号占用，返回SSO-1213提示管理员显式绑定，不自动合并。无占用则按原JIT创建新身份，角色采用显式映射，未分配部门的数据范围固定self；写审计。JIT创建与同邮箱本地创建使用同一锁，冲突无半笔身份。

显式绑定必须同时具备user.manage、sso.manage且为platform_admin；填写sub（1–255，拒绝空白/控制字符），issuer从当前OIDC_ISSUER配置获取而非客户端自报，CAS写入并审计。有效账号已经占用subject则409。已删除账号保留的subject阻止自动JIT，但管理员明确绑定给新账号时可以在同一事务清除旧绑定并记录原账号ID，旧数据不转移。解绑置NULL并撤销会话。客户端不接受任何自报角色或IdP claims替代验签。

## 4. 登录节流

新增MySQL `auth_login_limits`：key_hash CHAR(64) ascii_bin主键，attempts INT UNSIGNED，window_started_at/expires_at DATETIME(3)，到期索引。只存HMAC摘要，不存登录标识或密码。事务内按key排序锁两条额度：来源IP每分钟最多60次；账号（已查到用用户ID，未知用规范化标识）15分钟最多10次。先占额度再scrypt，跨实例/并发不会超额；成功清除账号额度，IP额度不清。已超额返回AUTH-1002/429及Retry-After秒数，未知账号同规则；旧窗口重置，过期行按维护周期清理。来源IP只用现有Fastify可信代理规则，不直接信任XFF。

## 5. 接口与错误（实际前缀/admin/api）

请求Schema集中contracts，除无体动作外均封闭对象；所有变更CSRF，更新/删除/密码/绑定/撤销会话要求If-Match；未知/不可见/已删除统一404，CAS失败409保留草稿。

| 路径 | 动作/输入 | 权限及输出 |
| --- | --- | --- |
| GET/POST /users | 列表支持q/status/limit/cursor；创建email/username/displayName/password?/role/dataScope/status/orgUnitId? | user.view/manage；snake_case兼容现有DTO，附has_local_password/授权动作；创建{id,revision} |
| GET/PATCH/DELETE /users/:id | 详情；编辑资料/角色/范围/状态/部门；逻辑删除 | user.view/manage+数据范围；更新{ok,revision} |
| POST /users/:id/password | {password}重置/设置 | user.manage+数据范围 |
| POST /users/:id/revoke-sessions | 无体 | user.manage+数据范围 |
| PUT/DELETE /users/:id/sso-binding | {subject}/无体 | 平台管理员+user.manage+sso.manage |
| POST /auth/password | {currentPassword,newPassword} | 有效会话+CSRF，成功清Cookie |
| POST /auth/local/login | 兼容email字段，接受登录名或邮箱；password原值 | 统一401；成功已有Session DTO |
| GET /audit | action/resourceType/resourceId/actorId/outcome/from/to/limit/cursor | audit.view+SQL范围过滤；默认50最大200、稳定created_at/id游标；items/nextCursor |
| GET /audit/:id | 详情 | 同范围，不可见404 |

用户DTO不返回password_hash；platform_admin才读idp_subject/emergency标志。db:seed仅按不可变bootstrap ID首次创建管理员；重复执行保留账号管理配置，已删除/改名/降权身份不恢复，不按邮箱重用提权。CASE覆盖删除bootstrap→新ID重用邮箱→携旧新会话重seed仍为普通用户。

错误沿既有CFG-8501/8503、AUTH-1001、POL-2001、RUN-7001，新增AUTH-1002（登录冷却）及SSO-1213（需要管理员绑定），同步注册表/文档/前端SSO错误白名单。

## 6. 操作日志与迁移

011增加users.idp_issuer（VARCHAR2048 NULL，不推断旧绑定issuer）、auth_login_limits及audit_logs.actor_name（VARCHAR128 NULL）、outcome（VARCHAR16 NOT NULL DEFAULT success）和检索索引；不回填伪造历史操作者。新增写入时从不可变actor_id读取显示名快照，详情保留actor_type/id/name；账号以后改名/删除不影响该记录。历史无快照显示原ID，不用当前同邮箱新用户替代。

账号成功变更的审计与写入同事务：action、资源ID、前后安全字段、org、requestId/IP/UA；密码只写passwordChanged=true，不写原文/哈希。SSO绑定记录sub变更，只向平台审计范围可见。部门转移同时写新部门user.update和旧部门user.org_transfer_out。

登录失败、账号操作拒绝/冲突在边界写failure/denied，只有固定action、目标ID、错误code和可信操作者；失败事件org记录可信操作者当时部门（匿名为NULL），不查询跨组织目标详情。这是失败操作本身的归属，成功资源事件仍按资源部门，不记录请求body、Cookie、密码、Token。失败审计写入失败记录一次脱敏服务日志，不把原认证拒绝变成成功。成功管理写入审计失败必须回滚。

迁移与Drizzle/schema.sql同步，forward-only、重复执行和010升级/空库均验证；服务启动前执行迁移，不自动升级日常库。回退保留新表/列，账号删除与SSO新规则含语义变更，不用旧版本恢复线上登录。

## 7. 页面与用例

沿用当前console组件与legacy入口，统一名称“账号与权限”。账号页提供搜索/状态/翻页、创建、编辑、重置密码、SSO绑定、撤销会话、删除及设置管理员；按真实权限显示。功能/数据/组织页签在U03/U04实现时接入，不做占位。操作日志独立导航、筛选/翻页/详情；本人改密从用户菜单进入。React与legacy登录均把“邮箱”改成“登录名或邮箱”，保留email请求字段兼容。弹窗pending、防重复、409保草稿、关闭清密码、焦点恢复沿用现有openModal机制。

CASE-I01资料→登录名/邮箱登录→改密→旧会话401→重置；I02删除→同标识新建→新ID/旧self不可读/旧cookie401；I03最后两个管理员并发撤销最多一个成功；I04越组织/被撤回权限/目标并发转移不得越权；I05未绑定同邮箱SSO拒绝、绑定登录保留本地权限、停用/删除身份不JIT复活；I06核验旧密码后重置再创建会话失败；I07账号/来源额度跨并发及到期/成功清零；I08日志安全前后值、删除后操作者快照、SQL范围/筛选游标/详情；I10切换issuer或subject大小写不能命中原绑定；I11无密码/无SSO绑定的管理员不计入可登录管理员，唯一SSO-only管理员解绑失败；I09全部正常页面入口、提交读回、409、关闭清密码与移动布局。

状态：READY FOR IMPLEMENTATION（仅本增量）。关键保证由现有MySQL事务/用户行锁/CAS组合与上述竞争顺序支撑；实现后必须执行反例测试和真实页面验收。目标生产/公司SSO未联调，不在此状态内。
