import { ForgeError } from "./errors/forge-error.js";
import { assertNoEnvRefs } from "./env-ref.js";
const invalid = (message: string) => new ForgeError("CFG-8501", { message });
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

export function validateSecretValue(value: string): void {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > 65536) throw invalid("凭据值必须为1–65536字节");
  assertNoEnvRefs({ apiKey: value });
}
export function validateCredentialHeader(value: string): void {
  if (/[^\t\x20-\x7E\x80-\xFF]/.test(value)) throw invalid("凭据值不能用于HTTP请求头");
}
function headerMap(raw: unknown, references: boolean): Record<string, string> {
  let value = raw;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { throw invalid("请求头必须为JSON对象"); } }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("请求头必须为JSON对象");
  const entries = Object.entries(value), names = new Set<string>();
  if (entries.length > 100 || Buffer.byteLength(JSON.stringify(value), "utf8") > 65536) throw invalid("请求头配置过大");
  for (const [name, v] of entries) {
    if (!HEADER_NAME.test(name) || names.has(name.toLowerCase()) || typeof v !== "string") throw invalid("请求头名称重复或格式无效");
    names.add(name.toLowerCase());
    if (references) { if (!/^[A-Za-z0-9_]{26}$/.test(v)) throw invalid("凭据引用ID无效"); }
    else { validateCredentialHeader(v); if (v) validateSecretValue(v); }
  }
  return Object.fromEntries(entries.map(([name, v]) => [name.toLowerCase(), v as string]));
}
export function credentialHeaderInput(raw: unknown): Record<string, string> { return headerMap(raw, false); }
export function credentialHeaderRefsInput(raw: unknown): Record<string, string> { return headerMap(raw, true); }
export function storedHeaderSecretRefs(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  try { return headerMap(raw, true); } catch { throw new ForgeError("SYS-9002"); }
}
