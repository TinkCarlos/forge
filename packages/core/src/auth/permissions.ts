import type { Principal } from "../index.js";

export const BUILTIN_ROLES = ["platform_admin", "org_admin", "builder", "operator", "auditor", "user"] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];
export const ROLE_PERMISSIONS: Record<BuiltinRole, string[]> = {
  platform_admin: ["*"],
  org_admin: [
    "agent.view",
    "agent.manage",
    "agent.publish",
    "agent.run",
    "skill.view",
    "skill.manage",
    "mcp.view",
    "mcp.manage",
    "tool.view",
    "tool.manage",
    "model.view",
    "model.manage",
    "run.view",
    "run.cancel",
    "approval.view",
    "approval.decide",
    "schedule.view",
    "schedule.manage",
    "schedule.run",
    "apikey.view",
    "apikey.manage",
    "plugin.install",
    "user.view",
    "user.manage",
    "audit.view",
    "usage.view",
  ],
  builder: [
    "agent.view",
    "agent.manage",
    "agent.publish",
    "agent.run",
    "skill.view",
    "skill.manage",
    "mcp.view",
    "mcp.manage",
    "tool.view",
    "tool.manage",
    "model.view",
    "model.manage",
    "run.view",
    "schedule.view",
    "schedule.manage",
    "schedule.run",
    "plugin.install",
    "usage.view",
  ],
  operator: [
    "agent.view",
    "agent.run",
    "run.view",
    "run.cancel",
    "approval.view",
    "approval.decide",
    "schedule.view",
    "schedule.run",
  ],
  auditor: ["run.view", "audit.view", "usage.view", "agent.view"],
  user: ["agent.view", "agent.run", "run.view"],
};

export const JOB_MESSAGE_PERMISSIONS = [
  "job.view", "job.manage", "job.publish", "job.run", "job.control", "job.retry",
  "job_delivery.manage", "human_task.view", "human_task.decide",
  "message.view", "message.manage", "message.test", "message.retry",
  "eval.view", "eval.manage", "eval.run", "eval.review",
] as const;

export const PERMISSION_CATALOG = Object.freeze([
  ...new Set([...JOB_MESSAGE_PERMISSIONS, ...Object.values(ROLE_PERMISSIONS).flat().filter(code => code !== "*"),
    "role.view", "role.manage", "org.view", "service_account.manage", "sso.manage", "secret.manage", "package.view", "plugin.uninstall"]),
].sort().map(key => ({ key, domain: key.split(".")[0]!, kind: "action", description: key })));

/** Templates are only for trusted manually constructed principals; database principals always carry permissions. */
export function permissionsFor(principal: Principal): readonly string[] {
  return principal.permissions ?? ROLE_PERMISSIONS[principal.role as BuiltinRole] ?? [];
}
export function hasPermission(principal: Principal | string, permission: string): boolean {
  const list = typeof principal === "string" ? ROLE_PERMISSIONS[principal as BuiltinRole] ?? [] : permissionsFor(principal);
  return list.includes("*") || list.includes(permission);
}
export interface AuthorizationRole { id: string; key: string; name: string; status: string }
export interface AuthorizationSnapshot { roles: AuthorizationRole[]; permissions: string[]; grantedPermissions: string[] }
export function readAuthorization(value: unknown): AuthorizationSnapshot {
  const empty = { roles: [], permissions: [], grantedPermissions: [] };
  if (!value || typeof value !== "object") return empty;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.roles) || !Array.isArray(row.permissions) || !Array.isArray(row.grantedPermissions) ||
      row.permissions.some(code => typeof code !== "string") || row.grantedPermissions.some(code => typeof code !== "string") ||
      row.roles.some(role => !role || typeof role !== "object" || ["id", "key", "name", "status"].some(key => typeof role[key] !== "string"))) return empty;
  return { roles: row.roles as AuthorizationRole[], permissions: row.permissions as string[], grantedPermissions: row.grantedPermissions as string[] };
}
