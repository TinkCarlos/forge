import { readFileSync, writeFileSync } from "node:fs";
import { ERROR_CODES } from "../packages/core/src/errors/codes.js";

const escape = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
const rows = Object.values(ERROR_CODES).sort((a, b) => a.code.localeCompare(b.code)).map(d => `| ${d.code} | ${escape(d.meaning)} | ${escape(d.userMessage)} | ${escape(d.remedy)} | ${d.httpStatus} | ${d.retryable} | ${d.audience} |`);
const content = `# Forge 错误码注册表\n\n由 \`packages/core/src/errors/codes.ts\` 生成，请勿手改。\n\n默认状态/重试语义由注册表提供；同一错误码在已有兼容场景可显式覆盖HTTP状态和重试策略（例如SSO-1201的未配置503与角色拒绝403）。\n\n| code | meaning | userMessage | remedy | httpStatus | retryable | audience |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`;
const file = new URL("../docs/reference/error-codes.md", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(file, "utf8") !== content) {
    console.error("错误码文档与注册表不同步，请运行 pnpm errors:generate");
    process.exit(1);
  }
} else writeFileSync(file, content);
