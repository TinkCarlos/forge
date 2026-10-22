import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

// AD / S-46: OUTBOUND_ALLOWLIST accepts only exact host:port entries. An invalid entry (wildcard, CIDR, bare host,
// bad port) makes config loading — i.e. process startup — fail instead of silently widening or ignoring the list.
// The subprocess only loads config; it never opens a database connection.
const root = path.resolve(import.meta.dirname, "..");
const loadConfig = (allowlist: string) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "VITEST") env[k] = v;
  env.DATABASE_URL = "mysql://forge:x@127.0.0.1:1/forge_test";
  env.OUTBOUND_ALLOWLIST = allowlist;
  return spawnSync(
    "pnpm",
    ["exec", "tsx", "-e", "import('./packages/core/src/config.ts').then((m) => console.log('CONFIG_OK ' + m.config.OUTBOUND_ALLOWLIST), (e) => { console.error(String(e?.message ?? e)); process.exit(1); })"],
    { cwd: root, env, encoding: "utf8", timeout: 30000 },
  );
};

describe("OUTBOUND_ALLOWLIST startup validation (AD, S-46)", () => {
  for (const ok of ["", "127.0.0.1:8090", "127.0.0.1:8090, sso.corp.internal:443,[::1]:9000"]) {
    it(`valid: "${ok}" -> starts`, () => {
      const out = loadConfig(ok);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain("CONFIG_OK");
    });
  }
  // AE: the startup error names only the offending entry (1-based position + its value) and why; it never echoes
  // the whole OUTBOUND_ALLOWLIST line, so the other (valid, possibly sensitive internal) entries stay out of logs.
  const reasons: Array<[string, string, string]> = [
    ["127.0.0.1:8090,10.0.0.0/8,secret-host.internal:9", '第 2 项 "10.0.0.0/8"', "不支持 CIDR"],
    ["secret-host.internal:9,*.example:443", '第 2 项 "*.example:443"', "不支持通配符"],
    ["secret-host.internal:9,127.0.0.1", '第 2 项 "127.0.0.1"', "缺少端口"],
    ["127.0.0.1:65536,secret-host.internal:9", '第 1 项 "127.0.0.1:65536"', "端口必须是 1-65535"],
    ["secret-host.internal:9,:80", '第 2 项 ":80"', "缺少主机"],
    ["secret-host.internal:9,127.0.0.1:8090:1", '第 2 项 "127.0.0.1:8090:1"', "格式应为 host:port"],
  ];
  for (const [line, which, why] of reasons) {
    it(`AE: "${line}" -> error names ${which} and why, not the whole line`, () => {
      const out = loadConfig(line);
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain(`OUTBOUND_ALLOWLIST ${which} 不合法：${why}`);
      expect(out.stderr).not.toContain(line);
      expect(out.stderr).not.toContain("secret-host.internal");
    });
  }
  it("AE: several invalid entries are each reported, valid ones are not echoed", () => {
    const out = loadConfig("10.0.0.0/8,secret-host.internal:9,*:*");
    expect(out.stderr).toContain('第 1 项 "10.0.0.0/8"');
    expect(out.stderr).toContain('第 3 项 "*:*"');
    expect(out.stderr).not.toContain("secret-host.internal");
  });

  for (const bad of ["127.0.0.1", "*.example:443", "10.0.0.0/8", "10.0.0.0/8:80", "host:", ":80", "127.0.0.1:8090:1", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:8090,*:*"]) {
    it(`invalid: "${bad}" -> startup error`, () => {
      const out = loadConfig(bad);
      expect(out.status, out.stdout).not.toBe(0);
      expect(out.stdout).not.toContain("CONFIG_OK");
      expect(out.stderr).toContain("OUTBOUND_ALLOWLIST");
    });
  }
});
