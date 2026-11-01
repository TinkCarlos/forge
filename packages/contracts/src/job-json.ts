export type JobJson = null | boolean | number | string | JobJson[] | { [key: string]: JobJson };

export function isJobJson(input: unknown): input is JobJson {
  const active = new Set<object>();
  const stack: { value: unknown; exit?: boolean }[] = [{ value: input }];
  while (stack.length) {
    const { value, exit } = stack.pop()!;
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") { if (!Number.isFinite(value)) return false; continue; }
    if (!value || typeof value !== "object") return false;
    if (exit) { active.delete(value); continue; }
    if (active.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) return false;
    active.add(value);
    stack.push({ value, exit: true });
    const values = Array.isArray(value) ? Array.from(value) : Object.values(value);
    for (const child of values) stack.push({ value: child });
  }
  return true;
}

/** Canonical JSON uses UTF-16 object-key order and preserves array order without recursive calls. */
export function canonicalJobJson(value: JobJson): string {
  const output: string[] = [];
  const stack: ({ value: JobJson } | { token: string })[] = [{ value }];
  while (stack.length) {
    const next = stack.pop()!;
    if ("token" in next) { output.push(next.token); continue; }
    const current = next.value;
    if (current === null || typeof current !== "object") { output.push(JSON.stringify(current)); continue; }
    const entries = Array.isArray(current) ? current.map((child, index) => [String(index), child] as const) : Object.keys(current).sort().map(key => [key, current[key]!] as const);
    const array = Array.isArray(current);
    output.push(array ? "[" : "{");
    stack.push({ token: array ? "]" : "}" });
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, child] = entries[index]!;
      if (index < entries.length - 1) stack.push({ token: "," });
      stack.push({ value: child });
      if (!array) stack.push({ token: `${JSON.stringify(key)}:` });
    }
  }
  return output.join("");
}
