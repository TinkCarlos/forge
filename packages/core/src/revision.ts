import { ForgeError } from "./errors/forge-error.js";

export const MAX_REVISION = 4_294_967_295;
export function revisionTag(revision: number): string {
  if (!Number.isInteger(revision) || revision < 1 || revision > MAX_REVISION) throw new ForgeError("CFG-8501", { message: "资源版本无效" });
  return `"${revision}"`;
}
export function requireRevision(value: unknown): number {
  if (value === undefined) throw new ForgeError("CFG-8505");
  if (typeof value !== "string" || !/^"[1-9]\d{0,9}"$/.test(value)) throw new ForgeError("CFG-8501", { message: "If-Match必须为单个有效版本标签", details: { field: "If-Match" } });
  const revision = Number(value.slice(1, -1));
  revisionTag(revision);
  return revision;
}
