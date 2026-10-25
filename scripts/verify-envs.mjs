#!/usr/bin/env node
// Gate: run `pnpm verify` once per NODE_ENV setting (development, test, unset).
// A setting passes only if verify exits 0 AND no test was skipped or left as todo (gate = 0 skip).
// Every setting runs even after a failure so the report is complete; the script
// exits 1 if any setting failed. Other env vars (DATABASE_URL etc.) pass through.
//
// Before each setting the console build output (apps/console/dist) is deleted so
// verify always starts clean. The path is derived from this script's own location
// (<repo root>/scripts/verify-envs.mjs), so only the worktree being verified is touched; the
// script refuses to run unless that root's package.json is named "forge".
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(repoRoot, "package.json");
if (!existsSync(pkgPath) || JSON.parse(readFileSync(pkgPath, "utf8")).name !== "forge") {
  console.error(`verify:envs: ${repoRoot} is not the forge repo root; refusing to run`);
  process.exit(2);
}
const consoleDir = join(repoRoot, "apps", "console");
const distDir = join(consoleDir, "dist");
if (!existsSync(join(consoleDir, "package.json"))) {
  console.error(`verify:envs: unexpected console path ${distDir}; refusing to run`);
  process.exit(2);
}

const SETTINGS = [
  { key: "development", label: "NODE_ENV=development", value: "development" },
  { key: "test", label: "NODE_ENV=test", value: "test" },
  { key: "unset", label: "NODE_ENV unset", value: undefined },
];
const only = process.argv.slice(2);
const unknown = only.filter((a) => !SETTINGS.some((s) => s.key === a));
if (unknown.length > 0) {
  console.error(`verify:envs: unknown argument(s) ${unknown.join(", ")}; use development, test or unset`);
  process.exit(2);
}
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function envFor(s) {
  const env = { ...process.env };
  if (s.value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = s.value;
  return env;
}

// Run verify, streaming output, and collect vitest "Tests ..." summary lines.
function runVerify(env) {
  return new Promise((done) => {
    const child = spawn(pnpm, ["verify"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const onData = (stream) => (chunk) => { stream.write(chunk); buf += chunk.toString(); };
    child.stdout.on("data", onData(process.stdout));
    child.stderr.on("data", onData(process.stderr));
    child.on("close", (code, signal) => done({ code: code ?? (signal ? 128 : 1), output: buf }));
  });
}

// List skipped test names for one vitest project by re-running it with the JSON reporter.
function listSkipped(env, filterArgs) {
  const out = join(mkdtempSync(join(tmpdir(), "verify-envs-")), "report.json");
  spawnSync(pnpm, [...filterArgs, "exec", "vitest", "run", "--reporter=json", `--outputFile=${out}`], { cwd: repoRoot, env, stdio: "ignore" });
  if (!existsSync(out)) return ["(could not produce JSON report to list skipped tests)"];
  const report = JSON.parse(readFileSync(out, "utf8"));
  const names = [];
  for (const file of report.testResults ?? [])
    for (const t of file.assertionResults ?? [])
      if (t.status === "skipped" || t.status === "pending" || t.status === "todo")
        names.push(`${file.name.replace(repoRoot + sep, "")} > ${t.fullName}`);
  return names;
}

const results = [];
for (const s of SETTINGS) {
  if (only.length > 0 && !only.includes(s.key)) continue;
  rmSync(distDir, { recursive: true, force: true });
  console.log(`\n=== verify:envs: ${s.label} (deleted ${distDir}) ===`);
  const env = envFor(s);
  const started = Date.now();
  const { code, output } = await runVerify(env);
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const summaries = [...plain.matchAll(/^\s*Tests\s+(.*)$/gm)].map((m) => m[1]);
  // Skipped and todo tests both count against the 0-skip gate.
  const countIn = (line) => [...line.matchAll(/(\d+)\s+(?:skipped|todo)/g)].reduce((n, m) => n + Number(m[1]), 0);
  const skipped = summaries.reduce((n, line) => n + countIn(line), 0);
  let skippedNames = [];
  if (skipped > 0) {
    // summaries[0] is the root suite, summaries[1] the console suite (verify order).
    // Listing names re-runs the affected suite with the JSON reporter (about 80s for the root suite);
    // this only happens when the gate is already failing.
    if (countIn(summaries[0] ?? "") > 0) skippedNames.push(...listSkipped(env, []));
    if (countIn(summaries[1] ?? "") > 0) skippedNames.push(...listSkipped(env, ["--filter", "@forge/console"]));
  }
  results.push({ label: s.label, code, skipped, skippedNames, seconds: Math.round((Date.now() - started) / 1000) });
}

if (results.length === 0) {
  console.error("verify:envs: no setting selected (use development, test or unset)");
  process.exit(2);
}
console.log("\n=== verify:envs summary ===");
for (const r of results) {
  const ok = r.code === 0 && r.skipped === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  ${r.label}  (exit ${r.code}, skipped ${r.skipped}, ${r.seconds}s)`);
  for (const n of r.skippedNames) console.log(`        skipped: ${n}`);
}
process.exit(results.every((r) => r.code === 0 && r.skipped === 0) ? 0 : 1);
