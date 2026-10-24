import Fastify from "fastify";
import { Writable } from "node:stream";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeTickError, logSafeError, redactCredentials } from "../packages/runtime/src/tick-guard.js";

// P2 (architect 4:51, QA 714b3f3 §4 P3-5): error-log redaction covers the six forms the QA probe found unmasked
// (unencoded `@` inside the password, JSON "password", Authorization/Bearer, bare key=value outside a query string,
// `#fragment` tokens, presigned-URL signatures), and no log site prints a raw error object any more (webhook.ts
// delivery failure, errors.ts 500 / duplicate key, auth.ts logout audit): they log logSafeError / describeTickError.
// Fake values only; the scheme is built at runtime.
const S = ["my", "sql"].join("") + "://";
const PROBES: Array<[string, string]> = [
  [`${S}u:p@ss-FAKE1@h:3306/db`, "FAKE1"],
  [`auth failed {"password":"FAKE2"}`, "FAKE2"],
  [`Authorization: Bearer FAKE3abcdef`, "FAKE3"],
  [`password=FAKE4 rejected`, "FAKE4"],
  [`${S}u:FAKE5%40x@h/db`, "FAKE5"],
  [`https://h/x?Token=FAKE6`, "FAKE6"],
  [`https://h/x#access_token=FAKE7`, "FAKE7"],
  [`https://h/x?sig=FAKE8&X-Amz-Signature=FAKE9`, "FAKE9"],
  [`https://h/x?sig=FAKE8&X-Amz-Signature=FAKE9`, "FAKE8"],
  [`https://h/x?X-Amz-Credential=FAKE10&X-Amz-Security-Token=FAKE11`, "FAKE10"],
  [`https://h/x?X-Amz-Credential=FAKE10&X-Amz-Security-Token=FAKE11`, "FAKE11"],
  [`{"client_secret": "FAKE12", "apiKey":"FAKE13"}`, "FAKE12"],
  [`{"client_secret": "FAKE12", "apiKey":"FAKE13"}`, "FAKE13"],
  [`authorization: Basic RkFLRTE0OnBhc3M=`, "RkFLRTE0"],
  [`header Authorization=FAKE15 sent`, "FAKE15"],
  [`login failed: token=FAKE16, retry`, "FAKE16"],
  [`{"password":"FA\\"KE17"}`, "KE17"],
];

describe("redactCredentials covers the missed forms", () => {
  it.each(PROBES)("%s -> no %s", (message, secret) => {
    const out = redactCredentials(message);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it.each([
    "duplicate entry for key 'uniq_email' code=ER_DUP_ENTRY",
    "https://h/x?page=2&sort=asc",
    "connect ECONNREFUSED 127.0.0.1:3306",
    "user a@example.com not found",
    "state machine moved to running",
  ])("leaves diagnostic text alone: %s", (message) => {
    expect(redactCredentials(message)).toBe(message);
  });

  it("keeps the non-secret parts readable", () => {
    expect(redactCredentials(`${S}u:p@ss-FAKE1@h:3306/db`)).toBe(`${S}[REDACTED]@h:3306/db`);
    expect(redactCredentials(`auth failed {"password":"FAKE2"}`)).toBe(`auth failed {"password":"[REDACTED]"}`);
    expect(redactCredentials("Authorization: Bearer FAKE3abcdef")).toBe("Authorization: Bearer [REDACTED]");
    expect(redactCredentials("https://h/x?sig=FAKE8&page=2")).toBe("https://h/x?sig=[REDACTED]&page=2");
  });
});

describe("logSafeError: a log-safe object instead of the raw error", () => {
  it("redacts message and stack, keeps type and code, drops everything else", () => {
    const error = Object.assign(new Error(`connect failed ${S}u:FAKE20@h/db`), { code: "ECONNREFUSED", config: { password: "FAKE21" }, sql: "INSERT 'FAKE22'" });
    const safe = logSafeError(error);
    const text = JSON.stringify(safe);
    for (const s of ["FAKE20", "FAKE21", "FAKE22"]) expect(text).not.toContain(s);
    expect(safe).toMatchObject({ type: "Error", code: "ECONNREFUSED" });
    expect(Object.keys(safe).sort()).toEqual(["code", "message", "stack", "type"]);
    expect(String(safe.stack)).toContain("[REDACTED]");
  });

  it("non-Error values become a short description", () => {
    expect(logSafeError(`token=FAKE23`)).toEqual({ type: "string", message: "token=[REDACTED]" });
    expect(logSafeError({ password: "FAKE24" })).toEqual({ type: "object", message: "non-error value thrown" });
    expect(describeTickError(new Error(`{"password":"FAKE25"}`))).not.toContain("FAKE25");
  });
});

describe("the API error handler never logs a raw error", () => {
  it("500 path: log line has no secret (message, stack, extra props)", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const { installErrorHandler } = await import("../apps/api/src/plugins/errors.js");
    const app = Fastify({ logger: { level: "info", stream } });
    installErrorHandler(app);
    app.get("/boom", async () => {
      throw Object.assign(new Error(`pool failed ${S}u:p@ss-FAKE30@h/db Bearer FAKE31abc`), { config: { password: "FAKE32" } });
    });
    app.get("/dup", async () => {
      throw Object.assign(new Error(`Duplicate entry 'FAKE33' for key 'k' {"password":"FAKE34"}`), { code: "ER_DUP_ENTRY", errno: 1062, sql: "INSERT ... 'FAKE35'" });
    });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/boom" })).statusCode).toBe(500);
    expect((await app.inject({ method: "GET", url: "/dup" })).statusCode).toBe(409);
    await app.close();
    const log = lines.join("");
    expect(log).toContain("[REDACTED]");
    for (const s of ["FAKE30", "FAKE31", "FAKE32", "FAKE34", "FAKE35"]) expect(log, s).not.toContain(s);
  });

  it("static: no raw error object is handed to a logger in apps/api/src or packages/*/src", () => {
    const root = join(import.meta.dirname, "..");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === "node_modules" || n === "dist" ? [] : walk(p);
      return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });
    const dirs = [join(root, "apps", "api", "src"), ...readdirSync(join(root, "packages")).map((p) => join(root, "packages", p, "src"))].filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
    const RAW = [
      /\bconsole\.(error|warn|log|info)\([^)]*,\s*(error|err|e|reason)\s*\)/,
      /\blog\.(error|warn|info|fatal)\(\s*(error|err|e)\s*[,)]/,
      /\berr:\s*(error|err|e)\s*[,}]/,
    ];
    const hits = dirs.flatMap(walk).flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => [f.slice(root.length + 1), i + 1, l] as const))
      .filter(([, , l]) => RAW.some((re) => re.test(l))).map(([f, n]) => `${f}:${n}`);
    expect(hits).toEqual([]);
  });
});
