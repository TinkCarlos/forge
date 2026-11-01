# 凭据库升级与密钥轮换

本节对应E1/FR-GV-08。当前命令已实现；目标Linux/生产实例未执行。操作前沿用[发布流程](release-process.md)完成备份与授权，不在测试库以外自动执行。业务凭据的信封密文存MySQL；主密钥、SSO和Connector引导密钥独立托管，真实值不得进入Git或日志。

## 010升级

1. 备份数据库和独立托管的旧主密钥；记录可恢复版本。排空旧API/Worker及配置维护写者，不允许旧镜像继续写明文Header。
2. 通过迁移Job执行`pnpm db:migrate --confirm-db=<database>`；010仅新增secrets/secret_versions/resource_references和5个引用列，009清单保持原18表。结构DDL中断可重跑；不能用Drizzle push或重复执行0000基线。
3. 启用理解Secret引用的新API/Worker/控制台；既有v1列只作兼容读取，新写全部引用。管理API不会读取回明文。
4. 执行`pnpm secrets:migrate --confirm-db=<database>`。逐行锁定最新父记录，将Provider bearer、App HMAC及Provider/MCP/OpenAPI非空Header转为resource Secret，清除旧值、增加revision并同事务审计。软删除MCP历史也覆盖，但不恢复运行可见性。重复执行changed应为0。
5. 输出只有计数及失败的resourceType/id/code。任何坏密文、env:或非法Header保留原行、failed增加且退出1；修复配置后重跑，不能以“扫描完”认定迁移成功。维护审计为system/null，Secret.created_by继承原归属。

`*_test`/`*_ux`可以直接执行，其余库必须精确`--confirm-db`。命令不会删除历史版本或输出值。迁移完成后的新引用不能被旧二进制理解，因此本批不承诺直接回退旧镜像；失败先停止新写，按备份/恢复演练恢复匹配服务与数据，不能把Header明文填回配置表。

## 私有keyring

不设置`FORGE_MASTER_KEYRING_FILE`时，`FORGE_MASTER_KEY`是唯一`legacy`版本。显式设置文件后仅按文件中的key版本读取，不回退环境变量。文件必须普通文件、当前进程用户所有、0600、非symlink、≤64KiB；最多64个版本，版本名1–64位字母数字及`._-`，每个base64解码后32字节。

文件结构（占位符必须由密钥管理器替换，不能直接部署）：

```json
{"activeVersion":"k2026-11","keys":{"legacy":"REPLACE_WITH_32_BYTE_BASE64_KEY","k2026-11":"REPLACE_WITH_ANOTHER_32_BYTE_BASE64_KEY"}}
```

使用受控路径原子替换文件；下一次操作重新读取。保留现有版本，先加入新key并切activeVersion，所有新Secret版本使用新包装key。文件损坏/丢失/模式不符或缺少目标key时失败关闭，不用上次缓存伪成功。值轮换通过管理API增加Secret版本，与主密钥轮换不同；轮换值不会自动启用disabled凭据。

## 重包裹与旧key退役

1. 先完成旧列回填，保持旧key和新key并存；备份keyring并验证数据库备份可恢复。
2. 执行`pnpm secrets:rewrap --confirm-db=<database>`。按id批量处理全部历史版本（包括disabled/deleted），逐行锁版本，验证数据可解密，只更新DEK包装/nonce/tag/key_version，保留值、版本、数据密文和Secret revision。审计失败整行回滚，中断可重跑；已是目标key的版本仍验证可读。
3. 固定activeVersion执行期间不得再次切换；发生变化会报告失败，不静默混作同一批成功。确认failed=0、keyVersions只剩当前key、legacyCiphertexts=0；脚本不会自动删除任何key。
4. **最终退役旧key前，必须排空所有在途Secret写事务和维护/配置写者，再复跑migrate、rewrap及残留统计。** 在线count=0可能漏掉已用旧key封装但尚未提交的事务，不构成退役许可。只读期间核对每个运行实例已加载新私有文件；确认备份恢复与灰度读路径后再由运维移除旧key。
5. 备份可能仍含旧包装密文，按备份保留周期安全托管旧key用于恢复；不能因在线库归零就销毁恢复材料。主密钥丢失且无备份时密文不可恢复，脚本不尝试猜key。

统计是当时状态；生产验收需实测排空、重启、旧备份恢复和每条真实使用路径。文件只改DEK包装的回退也必须保留可读的对应key，不能直接切回不含新版本的keyring。
