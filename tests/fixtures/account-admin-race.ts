import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { config, hashPassword } from "@forge/core";
import { execute, pool, repos } from "@forge/store";
if (!/^\/forge_identity_race_[a-z0-9]+_test$/.test(new URL(config.DATABASE_URL).pathname)) throw new Error("isolated race database required");
try {
  const admins = await Promise.all(["first", "second"].map(name => repos.createUser({ username: name, email: `${name}@forge.local`, displayName: name, role: "platform_admin", dataScope: "all", passwordHash: hashPassword("Race!2026") })));
  const outcomes = await Promise.allSettled(admins.map(id => repos.updateUser(id, { status: "disabled" }, { expectedRevision: 1 })));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  const rejected = outcomes.find(result => result.status === "rejected");
  assert(rejected?.status === "rejected"); assert.equal(rejected.reason.code, "CFG-8503");
  const active = (await repos.listUsers({})).filter(user => user.status === "active");
  assert.equal(active.length, 1);
  const id = active[0]!.id;
  const seedId = "01J00000000000000000000001";
  await repos.bootstrapAdmin({ id:seedId,email:config.FORGE_ADMIN_EMAIL,name:"Bootstrap",passwordHash:hashPassword("Bootstrap!2026"),orgUnitId:"01J00000000000000000000000" });
  await repos.updateUser(seedId, { status:"deleted" }, { expectedRevision:"system" });
  const reused = await repos.createUser({ username:"reused-admin",email:config.FORGE_ADMIN_EMAIL,displayName:"New identity",passwordHash:hashPassword("NewAccount!2026") });
  const { createSession, loadActivePrincipal, sessionWithPrincipal } = await import("@forge/identity");
  const session = await createSession((await loadActivePrincipal(reused))!);
  execFileSync("pnpm", ["db:seed"], { env:process.env,stdio:"pipe" });
  assert.equal((await repos.getUserById(seedId))!.status,"deleted");
  assert.equal((await sessionWithPrincipal(session))!.principal.role,"user");
  assert.equal((await repos.getUserById(reused))!.role,"user");

  await repos.upsertRoleMapping("mapped", "", "user", { expectedRevision: "system" });
  await repos.bindUserIdentity(id, "sso-only-admin", config.OIDC_ISSUER!, { expectedRevision: "system" });
  await repos.updateUser(id, { passwordHash: null }, { expectedRevision: "system" });
  await assert.rejects(repos.bindUserIdentity(id, null, null, { expectedRevision: "system" }), { code: "CFG-8503" });
  assert.equal((await repos.getUserById(id))!.idp_subject, "sso-only-admin");
  await execute("DELETE FROM oidc_role_mappings");
  const dummy = await repos.createUser({ username: "dummy", email: "dummy@forge.local", displayName: "dummy", role: "platform_admin", passwordHash: "scrypt$aa$bb" });
  await assert.rejects(repos.updateUser(id, { role: "user" }, { expectedRevision: "system" }), { code: "CFG-8503" });
  assert.equal((await repos.getUserById(dummy))!.role, "platform_admin");
  console.log("ACCOUNT ADMIN RACE PASS; one winner, one conflict; SSO unlink, empty mappings and malformed password guarded");
} finally { await pool.end(); }
