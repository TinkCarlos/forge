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
  for (const bad of ["127.0.0.1", "*.example:443", "10.0.0.0/8", "10.0.0.0/8:80", "host:", ":80", "127.0.0.1:8090:1", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:8090,*:*"]) {
    it(`invalid: "${bad}" -> startup error`, () => {
      const out = loadConfig(bad);
      expect(out.status, out.stdout).not.toBe(0);
      expect(out.stdout).not.toContain("CONFIG_OK");
      expect(out.stderr).toContain("OUTBOUND_ALLOWLIST");
    });
  }
});
