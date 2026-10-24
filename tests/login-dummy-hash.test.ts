import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

// S-32: local login runs one scrypt verification on every path, so the response time does not reveal whether the
// email exists, is SSO-only (no password_hash), has a malformed hash, or is disabled (getUserByEmail only returns
// active users). Checked by counting verifyPassword calls (a spy around the real implementation) and by the hash it
// was given: always a well-formed scrypt hash. Needs a *_test DB.
const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@forge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@forge/core")>();
  return {
    ...actual,
    config: { ...actual.config, ALLOW_LOCAL_LOGIN: true },
    verifyPassword: (password: string, stored: string) => {
      calls.push(stored);
      return actual.verifyPassword(password, stored);
    },
  };
});
const { hashPassword } = await import("@forge/core");
const { loginLocal } = await import("@forge/identity");
const { execute, repos } = await import("@forge/store");

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ROOT = "01J00000000000000000000000";
const PASSWORD = `pw-${randomBytes(9).toString("hex")}`;
const email = (n: string) => `it-s32-${n}-${suffix}@forge.local`;
const SCRYPT = /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/;

beforeAll(async () => {
  const base = { role: "user", dataScope: "self", orgUnitId: ROOT } as const;
  await repos.createUser({ ...base, email: email("ok"), username: `it-s32-ok-${suffix}`, displayName: "IT s32 ok", passwordHash: hashPassword(PASSWORD) });
  await repos.createUser({ ...base, email: email("sso"), username: `it-s32-sso-${suffix}`, displayName: "IT s32 sso" });
  await repos.createUser({ ...base, email: email("bad"), username: `it-s32-bad-${suffix}`, displayName: "IT s32 bad", passwordHash: "plain-text-legacy" });
  await repos.createUser({ ...base, email: email("off"), username: `it-s32-off-${suffix}`, displayName: "IT s32 off", passwordHash: hashPassword(PASSWORD), status: "disabled" });
});

afterAll(async () => {
  await execute("DELETE FROM users WHERE email LIKE ?", [`it-s32-%-${suffix}@forge.local`]);
});

async function attempt(address: string, password = PASSWORD): Promise<{ ok: boolean; hashes: string[] }> {
  calls.length = 0;
  const ok = await loginLocal(address, password).then(() => true, (e: { httpStatus?: number }) => {
    expect(e.httpStatus).toBe(401);
    return false;
  });
  return { ok, hashes: [...calls] };
}

describe("S-32: local login always runs exactly one scrypt check", () => {
  it("existing user, right / wrong password: one check against the stored hash", async () => {
    const right = await attempt(email("ok"));
    const wrong = await attempt(email("ok"), "nope");
    expect([right.ok, right.hashes.length, wrong.ok, wrong.hashes.length]).toEqual([true, 1, false, 1]);
  });

  it.each([
    ["unknown email", "nobody"],
    ["SSO-only user (no password_hash)", "sso"],
    ["malformed stored hash", "bad"],
    ["disabled user (correct password)", "off"],
  ])("%s: 401 after one check against a well-formed dummy hash", async (_label, who) => {
    const { ok, hashes } = await attempt(email(who));
    expect(ok).toBe(false);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(SCRYPT);
  });
});
