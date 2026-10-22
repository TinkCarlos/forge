/**
 * OUTBOUND_ALLOWLIST entry validation (AD / AE), shared by config loading and the outbound guard.
 * Entries must be an exact host:port (IPv6 as [addr]:port, port 1-65535): no wildcard, CIDR, bare host or port range.
 * Error texts name only the offending entry (1-based position + its own value) and the reason — never the whole
 * line, so the other entries (internal host names) do not end up in startup logs.
 */
export function allowlistEntryProblem(entry: string): string | null {
  if (entry.includes("*")) return "不支持通配符，只能写精确的 host:port";
  if (entry.includes("/")) return "不支持 CIDR 网段，只能写精确的 host:port";
  let host: string;
  let port: string;
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]");
    if (end < 0) return "格式应为 host:port（IPv6 写成 [addr]:port）";
    host = entry.slice(1, end);
    const rest = entry.slice(end + 1);
    if (rest === "") return "缺少端口，不支持只写 host";
    if (!rest.startsWith(":")) return "格式应为 host:port（IPv6 写成 [addr]:port）";
    port = rest.slice(1);
    if (!/^[0-9a-fA-F:.]+$/.test(host)) return "IPv6 地址不合法";
  } else {
    const colons = entry.split(":").length - 1;
    if (colons === 0) return "缺少端口，不支持只写 host";
    if (colons > 1) return "格式应为 host:port（IPv6 写成 [addr]:port）";
    [host, port] = entry.split(":") as [string, string];
    if (host !== "" && !/^[a-zA-Z0-9.-]+$/.test(host)) return "主机名含不允许的字符";
  }
  if (host === "") return "缺少主机";
  if (port === "") return "缺少端口，不支持只写 host";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return "端口必须是 1-65535 的整数";
  return null;
}

/** Problems for a whole OUTBOUND_ALLOWLIST value, one message per invalid entry (empty value → none). */
export function allowlistProblems(raw: string | undefined | null): string[] {
  const problems: string[] = [];
  String(raw ?? "")
    .split(",")
    .forEach((part, index) => {
      const entry = part.trim();
      if (!entry) return;
      const why = allowlistEntryProblem(entry);
      if (why) problems.push(`OUTBOUND_ALLOWLIST 第 ${index + 1} 项 ${JSON.stringify(entry)} 不合法：${why}`);
    });
  return problems;
}
