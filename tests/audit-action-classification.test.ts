import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDeleteClassAuditAction } from "../packages/store/src/repositories/audit-scope-sql.js";

// Audit action classification (pure, static). Delete-class actions must pass orgUnitId explicitly (repos.audit throws
// otherwise). The rule is a suffix rule: the last segment is one of the delete verbs, case-insensitive, any prefix of
// letters (camelCase included), digits, "_", "-" and ".". Every action literal written by the code is listed below
// with an explicit class, so a new action cannot slip in unclassified.
const REPO = join(import.meta.dirname, "..");
const ROOTS = [join(REPO, "apps", "api", "src"), ...readdirSync(join(REPO, "packages")).map((p) => join(REPO, "packages", p, "src"))];

const CLASSIFIED: Record<string, "delete" | "keep"> = {
  "agent.create": "keep", "agent.publish": "keep", "agent.update": "keep", "agent.version.create": "keep",
  "apikey.create": "keep", "app.create": "keep", "app.update": "keep", "approval.decide": "keep",
  "auth.login.local": "keep", "auth.login.oidc": "keep", "auth.logout": "keep",
  "integration.run.cancel": "keep", "integration.run.create": "keep",
  "mcp.create": "keep", "mcp.refresh": "keep", "mcp.update": "keep", "model.create": "keep", "model.update": "keep",
  "open.run.cancel": "keep", "open.run.create": "keep",
  "plugin.install": "keep", "plugin.install.failed": "keep", "plugin.uninstall": "delete",
  "provider.create": "keep", "provider.update": "keep", "role_mapping.upsert": "keep",
  "run.cancel": "keep", "run.create": "keep",
  "schedule.create": "keep", "schedule.disable": "keep", "schedule.enable": "keep", "schedule.run": "keep", "schedule.update": "keep",
  "service_account.create": "keep", "skill.create": "keep", "skill.update": "keep", "skill.version.create": "keep",
  "tool_source.import": "keep", "user.create": "keep", "user.org_transfer_out": "keep", "user.update": "keep", "webhook.replay": "keep",
};

function files(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** Action literals in apps/api/src and packages/*\/src: `action: "x"` and writeAudit/prepareAudit(session, "x", ...). */
function actionLiterals(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of ROOTS.flatMap(files)) {
    const src = readFileSync(file, "utf8");
    for (const re of [/\baction: "([^"]+)"/g, /\b(?:writeAudit|prepareAudit)\(\s*\w+,\s*"([^"]+)"/g]) {
      for (const m of src.matchAll(re)) found.set(m[1]!, file.slice(REPO.length + 1));
    }
  }
  return found;
}

describe("audit action classification", () => {
  it("every action literal in the code is explicitly classified (scanner sanity: finds plugin.uninstall and user.update)", () => {
    const found = actionLiterals();
    expect(found.has("plugin.uninstall") && found.has("user.update") && found.has("auth.logout")).toBe(true);
    const unclassified = [...found.keys()].filter((a) => !(a in CLASSIFIED));
    expect(unclassified, "add new audit actions to CLASSIFIED").toEqual([]);
    const stale = Object.keys(CLASSIFIED).filter((a) => !found.has(a));
    expect(stale, "CLASSIFIED lists actions no longer written").toEqual([]);
  });

  it("the explicit table agrees with the suffix rule", () => {
    for (const [action, cls] of Object.entries(CLASSIFIED)) expect([action, isDeleteClassAuditAction(action)]).toEqual([action, cls === "delete"]);
  });

  it("delete verbs, case-insensitive, any prefix with digits / camelCase", () => {
    const yes = [
      "agent.delete", "x.remove", "plugin.uninstall", "apikey.revoke", "x.purge", "x.destroy", "x.archive",
      "app.unbind", "device.detach", "account.unlink", "user.deactivate",
      "Agent.DELETE", "PLUGIN.Uninstall", "apiKey.Revoke", "toolSource.remove", "skill2.version3.remove", "role_mapping.Unbind", "oidc-provider.detach",
    ];
    const no = [
      "plugin.install", "agent.update", "schedule.disable", "deleted.thing", "agent.delete_draft", "agent.deleted", "x.removeAll",
      "x.unbinding", "x.detached", "delete", ".delete", "agent.delete.", "agent .delete", "x.attach", "x.bind", "x.link", "x.activate",
    ];
    for (const a of yes) expect([a, isDeleteClassAuditAction(a)]).toEqual([a, true]);
    for (const a of no) expect([a, isDeleteClassAuditAction(a)]).toEqual([a, false]);
  });
});
