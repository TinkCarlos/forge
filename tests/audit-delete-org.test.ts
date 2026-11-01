import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DELETE_CLASS_AUDIT_ACTION } from "../packages/store/src/repositories/audit-scope-sql.js";

// Delete-class audit actions must carry the resource department captured BEFORE the delete (pure, static).
// repos.audit resolves org_unit_id from the resource row when orgUnitId is omitted (AUDIT_ORG_SOURCES); once the row
// is gone that lookup returns NULL and the entry disappears from the department's audit list. So every audit call
// whose action is delete-like must pass orgUnitId explicitly (read from the row before deleting it; an explicit
// null for platform-level resources).
const ROOT = join(import.meta.dirname, "..", "apps", "api", "src");
// Same classifier repos.audit enforces at runtime (single source).
const DELETE_LIKE = DELETE_CLASS_AUDIT_ACTION;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** Every writeAudit(...) / prepareAudit(...) / repos.audit({...}) call: its action and the call text up to the matching parenthesis. */
function auditCalls(): Array<{ file: string; action: string; call: string }> {
  const out: Array<{ file: string; action: string; call: string }> = [];
  for (const file of files(ROOT)) {
    const src = readFileSync(file, "utf8");
    const re = /\b(writeAudit\(|prepareAudit\(|configurationWrite\(|\.audit\(\{)/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < src.length; end += 1) {
        if (src[end] === "(" || src[end] === "{") depth += 1;
        if (src[end] === ")" || src[end] === "}") depth -= 1;
        if (depth === 0) break;
      }
      const call = src.slice(m.index, end + 1);
      if (/^(writeAudit|prepareAudit)\(\s*session: Session/.test(call)) continue; // the helpers' own declarations
      const action = /configurationWrite\(\s*\w+,\s*\w+,\s*"([^"]+)"/.exec(call)?.[1] ?? /action: "([^"]+)"/.exec(call)?.[1] ?? /(?:writeAudit|prepareAudit)\(\s*\w+,\s*"([^"]+)"/.exec(call)?.[1];
      if (action) out.push({ file: file.slice(ROOT.length + 1), action, call });
    }
  }
  return out;
}

describe("delete-class audit rows keep the resource department", () => {
  it("the scan finds the audit calls (guards the scanner itself)", () => {
    const actions = auditCalls().map((c) => c.action);
    expect(actions).toContain("agent.create");
    expect(actions).toContain("plugin.uninstall");
    expect(actions).toContain("integration.run.cancel");
  });

  it("every delete-like audit call passes orgUnitId explicitly (captured before the delete)", () => {
    const deletes = auditCalls().filter((c) => DELETE_LIKE.test(c.action));
    // Inventory on this commit: plugin.uninstall is the only delete-class action (there is no agent.delete route).
    // A new delete action shows up here and must follow the same rule.
    expect(deletes.map((c) => c.action).sort()).toEqual(["plugin.uninstall", "role.delete", "secret.delete", "user.delete", "user.sessions.revoke", "user.sso.unbind"]);
    for (const c of deletes) expect({ action: c.action, file: c.file, explicitOrg: /\borgUnitId\b|target\.org_unit_id|, null\)$/.test(c.call) }).toEqual({ action: c.action, file: c.file, explicitOrg: true });
  });
});
