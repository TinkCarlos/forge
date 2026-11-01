# Forge E0 技术准入实测与交接

日期：2026-10-31；基线：`3cde87d`。本轮验证机制、制品和部署前提，并归档已核验内部制品；项目依赖未修改，未执行迁移、远程注册或发布。

## 1. 结论

**E0核心设计准入：READY FOR IMPLEMENTATION（E1–E3及Connector适配）。** 用户已确认专用Linux执行服务器，不部署容器/gVisor；实际服务器安装与业务联调仍为部署验收，不写成已经通过。

| 项目 | 状态 | 已关闭的决定/证据 |
| --- | --- | --- |
| Pi 1.4.0 审批/恢复 | PASS，真实SDK隔离机制实验 | 持久化屏障、混合批次挂起、审批后规范历史恢复、fatal阻断 |
| Connector 0.2.0制品 | PASS，实包核验和机制实验 | 正式包名、版本/hash、真实函数签名、缓存/版本与grant规则 |
| Connector数据范围来源 | PASS，补充签名策略实验 | 使用已验签call policy的dataScopeType/dataScope，SDK不代做行过滤；不再等待虚构的callSystem参数 |
| 执行部署架构 | 已由用户确定，官方机制可支持设计 | 专用Linux、workspace独立UID、持久目录、systemd/cgroup、无限制网络；不再需要K8s RuntimeClass/CSI前提 |
| 工程基线 | 已冻结实施边界 | ESLint/shadcn、Pi1.4.0、新表Drizzle schema与单一SQL迁移器；Node24另批验收 |

本结论证明设计可进入指定范围开发；没有把未运行的Linux/cgroup/配额、真实网关或整套224项业务验收改成PASS。

## 2. Pi 实验

在 `/private/tmp/forge-e0-pi-20261031` 安装 `@earendil-works/pi-agent-core@1.4.0`，临时 npm cache 独立，使用 `--ignore-scripts`，不修改项目 package.json/lock，不发送模型请求。Pi 包为 MIT；完整性与 Node 版本记录在 [results.json](e0/results.json)。首次下载被 registry TLS reset 中断，复用缓存重试后成功，不构成功能失败。

可复现实验：[pi-probe.mjs](e0/pi-probe.mjs)。它加载真实 Pi Agent 和 runToolCall，以确定性 stream 代替供应商，不用自写循环冒充 Pi。

```bash
node .talking-us/e0/pi-probe.mjs /private/tmp/forge-e0-pi-20261031
```

实测通过：

1. assistant message_end 的异步监听器先完成，工具才执行；模拟持久化提交后才允许副作用。
2. 同一批 read 完成、write 待审批：一次模型请求、一次 read、零次 write；finishTurn 显式 end 可停止混合批次。
3. 丢弃临时 pending 工具错误、只保存真实工具结果；批准后经 runToolCall 执行 write，重建规范消息并 continue，read/write 均不重复；拒绝/过期的beforeToolCall阻断不会执行write。
4. assistant 持久化监听器抛错：prompt 拒绝，所有工具执行计数为零。
5. 工具内 fatal 标记配合 abort/finishTurn：不会继续请求模型。

实现规则：持久化/租约/所有权错误必须设置 fatal 并 abort；每次真正副作用前独立复核 fence。不得仅抛普通工具异常，也不得依赖单个 terminate=true 终止混合批次。只有最终成功/拒绝/失败工具消息进入规范历史；pending 是协调器状态。

边界：该实验没有数据库事务、进程 kill、多节点、真实模型、真实审批 HTTP 或 Temporal；它关闭的是 Pi hooks 的关键组合可行性，不替代 C02/C03 的业务集成验收。

## 3. Connector 实包与协议

在本机找到 `/Users/libo/projects/agent-connector-0.2.0-developer-kit/`。其 release-manifest 指定版本0.2.0、build8、gitSha `2ae52adeb2cabf7662d89789fbeae00ef3de2177`。

| 制品 | 大小 | SHA256 |
| --- | --- | --- |
| leadong-agent-connector-0.2.0.tgz | 10218 bytes | eaf28f8ab99bfbb085a0078777f4ce923ad70e1044a8af7e7d8a82d6cdda20a3 |
| leadong_agent_connector-0.2.0-py3-none-any.whl | 13058 bytes | e8791941310c115502ab06b7ecbddf7fb174075aaa64dde71db3ea72fb3824f2 |

均重新计算并与清单、Forge原文档一致。Node 实包名为 **@leadong/agent-connector**，Node>=20，无运行时第三方依赖，license=UNLICENSED（公司内部制品，不是开源许可）；不是原文档占位包名 @your-org。已将核验制品、release-manifest和CHECKSUMS归档到[vendor/agent-connector](../vendor/agent-connector/README.md)，复制后再次校验通过。后续使用file依赖并锁完整性，不安装公共同名包，也不换成附近目录中的0.4.x。

已解压到临时目录，运行 [connector-probe.mjs](e0/connector-probe.mjs)：

```bash
node .talking-us/e0/connector-probe.mjs /private/tmp/forge-e0-connector/package
```

实测通过真实 SDK 的签名、过期/环境拒绝、配置降版拒绝、同版本同内容幂等、坏签名拒绝、LKG重载、0600缓存、callSystem本地grant校验。fetch是本机mock；未访问公司平台、未注册实例、未调用业务系统。Python只核验制品，不声称其SDK行为已经执行。

### 3.1 确定的适配规则

- Fastify使用 SDK 的 verifyAndAuthorizeInbound/verifyPrincipalToken 等公开函数，自行接 Fastify hook；不强行套 Express middleware。
- callSystem参数为 method/path/query/body/headers/**capabilityCode**/timeoutSeconds；开发文档的 capability 概念须映射到这个真实字段。
- 每实例独立 cachePath；refresh/apply 串行化。SDK apply 会在缓存写入前更新内存 current：任何缓存失败都将 Forge Connector readiness 置 false，阻止使用“只在内存成功”的版本。
- 在 MySQL记录每实例已接受版本高水位；启动LKG/刷新版本低于高水位拒绝。缓存成功且高水位提交成功后才对业务发布该版本。跨存储失败一律关闭该实例调用，禁止用旧缓存重新开放。所有SDK异常转换ForgeError，日志不回显完整载荷。
- 注册、心跳、配置刷新、出站和内置mock contract vectors均可按实包接口开发；生产参数仍由管理员部署时提供，不阻塞这些代码开发。

### 3.2 dataScope的真实来源与确定实施规则

前次只检查Principal与callSystem后推断缺上游协议，范围过大，现修正。开发包的`protocol/config-bundle.schema.json`已定义call policy上的`dataScopeType/dataScope`；真实SDK的ConnectorConfigStore保存整个已验签payload，authorizeCall/verifyAndAuthorizeInbound返回选中policy，扩展字段会保留。额外实验验证：这些字段经签名校验、LKG重载、入站/出站选择后仍存在，篡改范围而不重签会被拒绝。

SDK不把dataScope复制进normalized Principal，也不把额外dataScope调用参数发送到网关；**这不等于签名范围协议缺失，也不代表SDK已经执行数据范围过滤**。

确定的实现契约：

1. 范围只取自已验签当前配置中SDK选中的唯一peer/direction policy；先做身份、方法/路径/capability授权，再做范围校验；同peer配置歧义在配置接收时拒绝，不按数组顺序扩大权限。
2. Forge构造AccessContext时，将该policy的范围作为外部上限与本地主体当前范围交集。`all`只表示外部不再收紧，不能覆盖本地self/org限制；缺失、未知或畸形范围拒绝需行级数据的接口。
3. Forge自身组织资源支持`custom`扩展对象`{orgUnitIds:[ULID,...]}`，限定已知字段、非空合法ID、与本地组织范围取交集；其他custom形态不猜测含义。服务账号/App身份限制另行相交，不因有组织ID就获得其他主体数据。
4. `customer/project/order`不是Forge组织ID。业务工具必须登记scopeBinding：scopeType、policyIds字段（customer_ids/project_ids/order_ids）、请求位置path/query/body及JSON Pointer。单ID须属于有效集合，数组每项都须属于集合；缺映射/缺ID/空集合拒绝，不能用抓全量后过滤代替授权。列表能力需目标提供实际可执行的范围过滤契约，否则不发布。
5. 出站通过SDK正常callSystem发送受约束参数及capabilityCode；不伪造X-Agent身份/范围头。目标系统负责根据其已验签inbound policy再校验请求/查询范围；不能仅相信普通body/filter。配置部署必须双方grant一致，实际目标系统能力在E4联调确认。
6. 若将来收到已验签JWT中的额外dataScope，可以只作进一步收紧的可选扩展；当前0.2.0路径不以该字段存在为前提，不接受未验签字段。

以上范围读取和默认拒绝机制可以按确定规则开发；每个真实业务工具的参数映射来自其目标API契约，不是本轮模型臆造的业务字段。尚未接入的目标业务仍需E4正常集成验收，不再作为E0 SDK机制未知项。

## 4. 专用Linux原生执行准入

用户明确取消容器/gVisor方向，并选择“专用Linux执行服务器，只放执行器和会话文件”。原先Docker缺失、kubectl无context、CSI/RuntimeClass不明的发现保留为历史事实，但不再是当前设计前提，也不记成gVisor试验通过。

当前验证机为Darwin arm64，无法实跑Linux systemd。机制依据来自systemd 255官方文档：[User/WorkingDirectory及文件约束](https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html)、[CPU/内存/Tasks控制](https://www.freedesktop.org/software/systemd/man/255/systemd.resource-control.html)、[进程组停止](https://www.freedesktop.org/software/systemd/man/255/systemd.kill.html)、[服务与运行时间](https://www.freedesktop.org/software/systemd/man/255/systemd.service.html)。Linux实际安装条件单列，不冒充本机实测。

### 4.1 已冻结部署与恢复规则

- 初版单执行主机，每workspace固定独立UID/GID和0700目录；账号locked/nologin、无sudo、无cron/at/用户systemd持久任务，文件存在期间UID不复用。Pi模型/治理仍在Forge Worker，执行机不放数据库/SSO/模型Key。
- 每命令独立systemd service/cgroup；固定User、Group、WorkingDirectory、UMask=0077、NoNewPrivileges、空CapabilityBoundingSet及ProtectSystem=strict，只允许对应workspace写入。不设置网络namespace/地址ACL，公网/内网按实际路由开放。
- broker只处理签名的固定操作/ID，运维预置或由专用受限特权helper管理账号/单元；脚本账号无权修改broker配置、环境profile、单元属性和管理凭据。
- CPUQuota200%、MemoryMax2GiB、TasksMax256、RuntimeMaxSec300（模板上限1800）、TimeoutStopSec5、KillMode=control-group、SendSIGKILL=yes、Restart=no。磁盘使用每UID用户硬配额及inode配额；不能用定期du替代硬配额。
- Idle回收进程/句柄/缓存，不删除或卸载持久目录；文件、venv、node_modules保留，runtime manifest fingerprint确定Node/Python路径、版本、架构和兼容性。恢复不保证进程内存或任意OS镜像。
- cgroup为空后才做目录检查点；cancel确认所有子进程停止后才写终态。主机失联禁止自动迁到第二机继续写，先恢复原机或确认旧机关机，再做受控灾难恢复。

### 4.2 实际服务器安装与运行闸门（待执行）

| 条件 | 安装检查 | 运行验收 |
| --- | --- | --- |
| Linux/systemd/cgroup v2 | Linux、systemd>=255、CPU/memory/pids控制器；锁定解释器版本 | 进程资源上限、启动失败和退出码真实可查 |
| UID/目录/broker权限 | 专用数据盘、workspace账号映射、0700/0077、只读环境profile、管理票据隔离 | 跨UID读写拒绝，脚本无法提升权限或调用管理helper |
| 用户配额 | 工作盘支持并启用用户block/inode quota | 有限技术载荷触发配额后不能破坏其他目录 |
| 停止与重启 | systemd日志/本地意图日志、bootId及unit命名 | setsid子进程仍被cgroup停止；服务/主机重启不重复执行未知副作用 |
| 文件保留 | 固定目录与runtime fingerprint、对象存储测试桶 | 多轮、idle、检查点失败、备份恢复、venv链接/权限一致 |
| 网络开放 | 无Forge出站ACL，执行机DNS/路由可用 | 指定测试公网/内网访问，目标认证错误如实反馈 |

上表是明确的可执行部署规格，实施者不需要选容器运行时或猜恢复行为；目标服务器的实际版本和账号由部署时配置，不能被本轮文档判定为已存在。

## 5. 交接状态

Pi与Connector实验脚本、输出及完整性记录均在本目录e0/；原方案、数据字段、接口和需求矩阵按Linux原生执行同步。E1–E3核心开发与SDK适配达到设计READY；P1/P2、实时流式脱敏和各目标业务工具仍按原批次补专项规格。

Linux服务器运行验收、公司SSO/Connector真实联调、数据库迁移和生产发布未执行。它们是后续交付闸门，不是本轮已验证结果。不得以E0局部机制通过代替生产接入验收。
