import { ForgeError } from "./errors/index.js";

export function accountText(value: string, field: "username" | "email" | "displayName"): string {
  const text = value.trim();
  const max = { username: 64, email: 255, displayName: 128 }[field];
  if (!text || Array.from(text).length > max || /[\u0000-\u001f\u007f]/u.test(text)) throw new ForgeError("CFG-8501", { message: `${field} 格式无效`, details: { field } });
  if (field === "email" && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text) || /@deleted\.forge\.invalid$/iu.test(text))) throw new ForgeError("CFG-8501", { message: "邮箱格式无效", details: { field } });
  if (field === "username" && text.toLowerCase().startsWith("__deleted__")) throw new ForgeError("CFG-8501", { message: "登录名不可用", details: { field } });
  return text;
}

export function assertAccountPassword(value: unknown, field = "password"): asserts value is string {
  if (typeof value !== "string" || Array.from(value).length < 8 || Array.from(value).length > 256) throw new ForgeError("CFG-8501", { message: "密码长度必须为8至256个字符", details: { field } });
}
