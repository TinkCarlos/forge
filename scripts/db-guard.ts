// OPS-026: database guards. Pure functions (no I/O) plus a small helper the scripts call before writing.

export type GuardResult = { ok: true; url: string; database: string } | { ok: false; reason: string };

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")).trim();
}

/**
 * Tests: only TEST_DATABASE_URL is used (DATABASE_URL from .env is never inherited). The database name must end with
 * "_test" ("_ux" and everything else is refused). There is no bypass.
 */
export function checkTestDatabase(env: Record<string, string | undefined>): GuardResult {
  const raw = env.TEST_DATABASE_URL?.trim();
  if (!raw) {
    return { ok: false, reason: "未设置 TEST_DATABASE_URL：测试只使用 TEST_DATABASE_URL，不会继承 .env 里的 DATABASE_URL。请指向以 _test 结尾的库，例如 mysql://forge:***@127.0.0.1:3306/forge_test" };
  }
  let database: string;
  try {
    database = databaseName(raw);
  } catch {
    return { ok: false, reason: "TEST_DATABASE_URL 不是合法的连接串" };
  }
  if (!database.endsWith("_test")) {
    return { ok: false, reason: `拒绝在库「${database || "(空)"}」上跑测试：库名必须以 _test 结尾（测试会写入并删除数据）。` };
  }
  return { ok: true, url: raw, database };
}

/** The value of --confirm-db=<name> in argv (last one wins), or null. A bare --confirm-db / --yes is not a confirmation. */
export function confirmDbArg(argv: readonly string[]): string | null {
  let value: string | null = null;
  for (const arg of argv) if (arg.startsWith("--confirm-db=")) value = arg.slice("--confirm-db=".length);
  return value;
}

/** Seed / migrate: *_test and *_ux are free; any other database needs --confirm-db=<exact database name>. */
export function checkScriptDatabase(url: string, argv: readonly string[]): GuardResult {
  let database: string;
  try {
    database = databaseName(url);
  } catch {
    return { ok: false, reason: "DATABASE_URL 不是合法的连接串" };
  }
  if (database.endsWith("_test") || database.endsWith("_ux")) return { ok: true, url, database };
  if (database && confirmDbArg(argv) === database) return { ok: true, url, database };
  return { ok: false, reason: `将要写入库「${database}」（不以 _test 或 _ux 结尾）。确认无误请加参数 --confirm-db=${database} 后重试。` };
}

/** Exits the script (code 1) unless checkScriptDatabase passes. Call before the first write. */
export function requireScriptDatabase(url: string, action: string): void {
  const result = checkScriptDatabase(url, process.argv.slice(2));
  if (!result.ok) {
    console.error(`Refusing to ${action}: ${result.reason}`);
    process.exit(1);
  }
}
