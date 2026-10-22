// Runs the smoke suite against a throwaway database so the console DB stays clean.
// Flow: reset + migrate + seed FORGE_SMOKE_DB, start a private API, run smoke, stop the API.
// The private API needs the mock services on :8090 (pnpm mock:services), same as plain smoke.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const baseUrl = new URL(process.env.DATABASE_URL ?? "mysql://forge:forge_dev_password@127.0.0.1:3306/forge");
const dbName = process.env.FORGE_SMOKE_DB ?? "forge_test";
if (!/_(smoke|test)$/.test(dbName)) {
  console.error(`Refusing: FORGE_SMOKE_DB must end with _smoke or _test (got ${dbName}).`);
  process.exit(1);
}
if (baseUrl.pathname.replace(/^\//, "") === dbName) {
  console.error("Refusing: smoke database must differ from DATABASE_URL.");
  process.exit(1);
}
const smokeUrl = new URL(baseUrl.toString());
smokeUrl.pathname = `/${dbName}`;
const port = process.env.FORGE_SMOKE_PORT ?? "3199";
const env = { ...process.env, DATABASE_URL: smokeUrl.toString(), PORT: port, NODE_ENV: "development" };

function step(label: string, args: string[], extra: Record<string, string> = {}): void {
  console.log(`▶ ${label}`);
  const result = spawnSync("pnpm", ["exec", "tsx", ...args], { stdio: "inherit", env: { ...env, ...extra } });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status})`);
}

async function waitHealthy(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`API on ${url} not healthy in ${timeoutMs}ms`);
}

let api: ChildProcess | null = null;
let code = 0;
try {
  step(`reset ${dbName}`, ["scripts/reset.ts"], { FORGE_ALLOW_RESET: "true" });
  step("migrate", ["scripts/migrate.ts"]);
  step("seed", ["scripts/seed.ts"]);
  console.log(`▶ start API on :${port}`);
  api = spawn("pnpm", ["exec", "tsx", "apps/api/src/server.ts"], { stdio: ["ignore", "ignore", "inherit"], env, detached: true });
  await waitHealthy(`http://127.0.0.1:${port}/healthz`);
  step("smoke", ["scripts/smoke.ts"], { FORGE_BASE_URL: `http://127.0.0.1:${port}` });
  console.log(`✓ isolated smoke passed (db ${dbName}, console DB untouched)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  code = 1;
} finally {
  if (api?.pid) {
    try { process.kill(-api.pid, "SIGTERM"); } catch {}
  }
}
process.exit(code);
