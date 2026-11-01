# Agent Connector 内部制品 0.2.0

来源：本机 Agent Connector 0.2.0 developer kit，release-manifest 的 build 8 / gitSha `2ae52adeb2cabf7662d89789fbeae00ef3de2177`。制品与 Forge 接入文档规定的 SHA256/大小一致；2026-10-31 复制后再次校验。

Node 包名 `@leadong/agent-connector`，Node>=20，license=UNLICENSED（内部制品）。Python wheel 同版本。不从公共 npm/PyPI 获取同名包；本次仅归档，项目依赖尚未添加。

校验：在本目录执行 `shasum -a 256 -c CHECKSUMS.sha256`。正式引入使用本目录 file 依赖，保留原始二进制，不修改SDK内部代码。

实验与适配边界见 [E0报告](../../.talking-us/2026-10-31-forge-e0-admission.md)。缺真实实例配置时开关继续关闭。
