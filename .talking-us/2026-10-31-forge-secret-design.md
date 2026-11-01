# E1 凭据库、引用及密钥版本

日期：2026-10-31；关联W01 §4.3、FR-GV-08、FR-MCP-02、FR-MD-08、FR-UI-12；FR-TL-03完整鉴权表单仍归E4，不因本批Header注入关闭。完整范围仍见开发进度及224项矩阵。

## 1. 决定与机制依据

用户已确认三种作用域：平台、组织、指定资源；组织凭据只绑定本组织资源，指定资源只用于该资源，不包含组织子树。管理可见性与使用范围分开：secret.manage和SQL数据过滤控制元数据管理；运行按已保存的资源绑定取用，不把secret.manage要求转嫁给普通运行用户。组织管理范围可以包含子部门，但某份org凭据的使用仍是精确组织相等。

当前MVP在Provider.api_key_encrypted、App.webhook_secret_encrypted保存单主密钥v1密文，MCP/工具源/Provider headers_json保存字面值；callModel、MCP发现/调用、OpenAPI调用和Webhook各自行读取。encryptSecret/decryptSecret保留v1兼容读，不能把现状称作信封加密。现有版本锁/事务审计、MySQL迁移器、Drizzle差分与JSON Schema沿用。

本地Node22机制探针已验证AES-256-GCM的AAD换上下文会拒绝解密、重新包裹DEK后数据密文保持不变且可解密。未来实现还须覆盖密文/tag/nonce篡改与错误/缺失key_version。没有外部KMS、付费请求或真实业务数据操作。

## 2. 确定的数据与密文契约

- secrets：id CHAR26 ascii PK；key VARCHAR64、name128、description1024；scope_type=platform/org/resource；scope_id CHAR26 NOT NULL（platform为空串，接口返回null）；scope_resource_type VARCHAR32 NOT NULL（非resource为空串）。资源类型为agent/llm_provider/mcp_server/tool_source/api_app；创建时确认资源存在且可管理。owner_org_unit_id记录资源/组织归属、created_by记录创建人，均可空CHAR26。active_version_id可空CHAR26，status active/disabled/deleted，revision UINT默认1，UTC created_at/updated_at/deleted_at。scope创建后不改；唯一(scope_type,scope_resource_type,scope_id,key)，无NULL唯一键漏洞；索引owner_org/status/id及created_by/status/id。
- secret_versions：id CHAR26 PK，secret_id FK RESTRICT，version UINT从1递增，ciphertext MEDIUMBLOB、nonce VARBINARY12、tag VARBINARY16；encrypted_dek VARBINARY32、dek_nonce12、dek_tag16、key_version VARCHAR64；created_by/created_at。唯一(secret_id,version)，索引(key_version,id)。每版本独立随机32-byte DEK，数据和DEK均AES-256-GCM；AAD规范化绑定secretId、version及不可变scope。版本正文不可更新；主密钥重包裹只改DEK包装及key_version，不改变值/版本/数据密文。
- resource_references沿用目标通用表：id、from_type/from_id/from_version_id、to_type/to_id/to_key/to_version、created_at，补binding_key VARCHAR255表达当前资源的api-key/webhook/header:<lowercase-name>槽位；唯一(from_type,from_id,binding_key)，索引(to_type,to_id)、(from_type,from_id)。当前只落地secret目标；其他资源引用随相应实际消费者补齐。多态关系不伪造跨表FK，写入按父资源及目标Secret行锁维护，删除资源时须同事务解除其引用。
- Provider补secret_id和header_secret_refs_json；MCP/工具源补header_secret_refs_json；App补webhook_secret_id。旧列兼容保留，清除延后版本；正常新写只存引用。所有非空Header值都进入凭据库（空串不是秘密，保留字面空串），不依赖敏感键名猜测。header refs为{name:secretId}，Header名按HTTP token校验，大小写去重；值用于HTTP时拒绝CR/LF，不回显非法值。
- 010为结构扩展；Drizzle生成SQL接唯一db:migrate。009固定自身18表清单，不能随未来CONFIGURATION_TABLES扩展而改写历史。bootstrap同步新表/列。010中断按缺表/列/索引恢复，不创建第二套历史。

## 3. 密钥来源与轮换

FORGE_MASTER_KEY继续用于legacy v1兼容，默认key_version=legacy。可配置FORGE_MASTER_KEYRING_FILE，文件为{activeVersion,keys:{version:base64Key}}；每个key必须32-byte，版本1–64位字母数字._-，最多64个、文件<=64KiB；普通文件、属当前用户、0600，不接受symlink。原子替换文件后下一次读写使用新内容，不将原始内容/路径载荷放进错误或日志。不设置文件时仅legacy环境密钥，不自动生成生产密钥。显式keyring缺版本时失败关闭，不遍历尝试其他密钥，也不偷偷退回环境密钥。

新凭据版本使用当前activeVersion；旧版本按自己的key_version读取。凭据值轮换为管理API新增版本并原子切active_version_id，无需重启。运维secrets:rewrap逐批锁定secret_versions，解出DEK并用当前activeVersion重包裹，验证可读后提交；中断重跑，最后按key_version统计及legacy残留检查。最终退役旧key前须排空全部在途凭据写事务，再复跑回填、重包裹和统计；在线count=0不能排除旧封装事务晚提交。旧备份所需key按保留周期单独托管。未归零不得移除旧密钥。脚本不自动删密钥或输出明文。密钥文件损坏/丢失会拒绝取用，不使用上次缓存伪成功。

## 4. 管理与运行规则

- 新增/list/detail/版本元数据/metadata PATCH/rotate/DELETE均要求secret.manage、数据范围过滤；未认证401、无功能权限403、不可见与不存在404。self按created_by；org按管理范围内owner_org_unit_id；all允许平台。平台配置写仍需all。scope org和resource必须对目标可管理，不因知道ID获得能力。
- POST /admin/api/secrets接key/name/description?/scope/value；只写值，响应和任何GET不含明文/密文/nonce/tag/DEK。PATCH仅name/description/status；rotate接value；PATCH/rotate/DELETE要求If-Match，事务审计失败整笔回滚。版本按行锁分配，409不新增孤立版本。创建后的scope不可改，避免旧绑定越界。
- disable立即拒绝下一次取用，即使已有绑定；reactivate需显式PATCH。rotate不隐式解除disabled。DELETE有引用409；无引用软删除并保留密文历史/审计，列表默认隐藏deleted。元数据列出activeVersion、keyVersion、引用数、版本列表和引用资源（均过滤到可见范围）。
- 重用既有secretId绑定须secret.manage及凭据可见、作用域匹配；仅有资源管理权限不能靠猜ID借用他人秘密。原有资源表单可写入自己知道的值，由后端同事务创建该资源作用域的Secret并绑定；这不授予凭据元数据管理权，不复活已停用的旧Secret。替换值解绑旧Secret、新建受控绑定，旧版本不覆盖。
- 资源更新：认证/可见性/原校验→父资源CAS行锁→按id排序锁目标Secret→检查active和精确作用域→写引用/父配置/审计→提交。Secret删除先锁Secret再COUNT引用，绑定也锁同一行，禁止删除与绑定竞态。无外部网络请求在事务中。
- 运行只按资源id、槽位及已提交reference查询当前active版本，复核active/scope/引用归属后解密；不向Prompt/消息/工具定义/Temporal历史返回秘密。只有实际HTTP Header/HMAC注入边界获得值；禁用或坏密文为SYS-9002、非重试，不发送外部请求。未迁移legacy列按旧v1规则兼容读取且不扩大env:引用；新引用存在时不能回退legacy绕过禁用。
- 已知值回显脱敏不改固定role/type/usage；工具参数和对象/数组正文只改JSON字符串值token，保留数字原始字面量（含int64）/布尔/格式。工具名、自定义Schema标识符、约束或自由JSON键含完整凭据时SYS-9002拒绝，不能悄悄改字段名或转发原值；短/低熵Header也可发生此显式冲突。Schema子节点、enum/const实例、dependencies映射和未知扩展按不同位置处理，不能误判合法实例type字段。疑似JSON流缓冲完整后解析，其他正文继续分片遮蔽。
- Provider bearer、MCP发现/工具调用、OpenAPI Header、Webhook签名共享取用机制。Connector目标凭据继续由Connector/Gateway管理，不复制目标密钥进Forge；OIDC/Connector引导密钥属部署身份配置，不冒充本批已迁入业务凭据库。Agent secret使用随E2/E3的实际执行绑定接入。

## 5. 升级与失败恢复

secrets:migrate在独立受控脚本中扫描四类旧配置，逐行锁定并读取最新revision，校验/解密→创建资源作用域Secret/引用→清除legacy值、改父引用并revision+1→审计→同事务提交。已经迁移的槽位不重复创建；请求头按完整集合迁移，不把未知Header遗留明文。坏密文、env:或非对象/非字符串Header不自动丢弃/伪成功：报告资源类型/id/错误码，保留原行，整体退出非0；修复后可重跑。日志无值和完整载荷。

结构升级先于新服务；排空旧配置写者。新服务兼容旧列只供迁移窗口读取，新写全部引用；迁移完成逐项查询残留，未归零不宣布完成/退役旧key。新引用写入后旧镜像不理解引用，故本批不承诺直接回退旧二进制；回退先停止新写并按备份/运维恢复方案，不能重新填回明文Header。验证中仅操作独立*_test库，实际生产迁移仍按既有发布授权。

## 6. 页面、契约与验收

沿用现有legacy控制台布局，在治理增加“凭据”，React侧栏跳此页。列表列名称/Key/作用域/当前版本/主密钥版本/引用数/状态/操作；创建、轮换的值字段只写，成功关闭时清空，任何重开不预填旧值；引用详情显示资源及槽位。启停/删除有确认、pending防重复、409保留草稿。无secret.manage不显示入口，后端仍强制校验。复用现有表单/表格/确认框和390px样式，不另加说明面板。

Provider/MCP/App表单保留原有只写值入口，并可配置已有secret refs；编辑时空白表示不改，不把空白默认JSON覆盖原有绑定；显式清除单独操作，不能用空字符串猜意图。API JSON Schema/DTO/OpenAPI与调用方同步，输入/结果字段封闭；列表采用id稳定游标与limit（默认50、最大200），不新增未治理临时接口。

CASE SEC01信封/篡改/AAD/未知版本；SEC02热切keyring/权限/坏文件；SEC03管理正常/拒绝/永不读明文；SEC04并发轮换/If-Match/审计回滚；SEC05作用域精确匹配/跨组织/猜ID；SEC06绑定与删除/停用竞态；SEC07五条实际注入链路/撤销后不发请求；SEC08旧列回填/故障保留/重跑/日志无值；SEC09重包裹/保留旧版本/中断恢复；SEC10浏览器完整入口/冲突/重访/移动视口。整体Secret目标需以上及迁移/回归/独立审查齐备才关闭，不以纯crypto测试代替。

状态：READY FOR IMPLEMENTATION。作用域产品决定已确认；加密与现有调用链有证据，剩余运行保证按上述确定事务/失败顺序实施并验收。生产Linux/真实凭据迁移未执行，不作为本地设计就绪的证据。
