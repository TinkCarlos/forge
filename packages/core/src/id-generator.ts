import { ulid } from "ulid";
import { ForgeError } from "./errors/forge-error.js";
import { ID_LENGTH, ID_PREFIX_LENGTH } from "./ids.js";

export const newId = (): string => ulid();

const PREFIX_RULE = /^[a-z]{3}$/;

export function ulidWithPrefix(prefix: string): string {
  // Any other prefix length would change the suffix length (26 - prefix - 1) and break ID_PATTERN.
  if (!PREFIX_RULE.test(prefix)) throw new ForgeError("CFG-8501", { message: `ulidWithPrefix: prefix must be 3 lowercase letters (got ${JSON.stringify(prefix)})` });
  return `${prefix}_${ulid().slice(0, ID_LENGTH - ID_PREFIX_LENGTH - 1)}`;
}
