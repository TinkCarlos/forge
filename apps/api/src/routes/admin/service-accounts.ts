import { type FastifyInstance } from "fastify";
import { errors, ForgeError, ROLE_PERMISSIONS, type Principal } from "@forge/core";
import { repos, type ServiceAccountRow } from "@forge/store";
import { bodyOf, param, stringBody, admin, writeAudit, requireBodyString } from "../../plugins/http-helpers.js";

// Service accounts (permissions.md §3.4): machine identities for schedules/integrations.
// Independent role + data scope, cannot log in. Disabling one pauses its schedules (SCD-4801).
const SERVICE_ACCOUNT_DATA_SCOPES = ["org", "all"];
const SERVICE_ACCOUNT_STATUSES = ["active", "disabled"];

export function presentServiceAccount(row: ServiceAccountRow): Record<string, unknown> {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    orgUnitId: row.org_unit_id,
    role: row.role,
    dataScope: row.data_scope,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serviceAccountVisible(principal: Principal, row: ServiceAccountRow | null): row is ServiceAccountRow {
  if (!row) return false;
  return principal.dataScope === "all" || row.org_unit_id === principal.orgUnitId;
}

function validateRoleAndScope(principal: Principal, role: string, dataScope: string): void {
  if (!Object.keys(ROLE_PERMISSIONS).includes(role)) throw errors.invalid("非法角色");
  if (role === "platform_admin") throw new ForgeError("SCD-4804", "服务账号不能是 platform_admin", 400);
  if (principal.role !== "platform_admin" && ["platform_admin", "org_admin"].includes(role)) throw errors.forbidden("不能授予该角色");
  if (!SERVICE_ACCOUNT_DATA_SCOPES.includes(dataScope)) throw errors.invalid("服务账号数据范围只能是 org 或 all");
  if (dataScope === "all" && principal.dataScope !== "all") throw errors.forbidden("不能授予超出自身的数据范围");
}

export default async function adminServiceAccountRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/api/service-accounts", async (request) => {
    const session = await admin(request, "service_account.manage");
    const rows = await repos.listServiceAccounts();
    return { items: rows.filter((row) => serviceAccountVisible(session.principal, row)).map(presentServiceAccount) };
  });

  app.post("/admin/api/service-accounts", async (request) => {
    const session = await admin(request, "service_account.manage");
    const body = bodyOf(request);
    const name = requireBodyString(body, "name");
    const key = stringBody(body, "key", `svc-${Date.now()}`);
    if (await repos.getServiceAccountByKey(key)) throw errors.conflict("服务账号 key 已存在");
    const role = stringBody(body, "role", "user");
    const dataScope = stringBody(body, "dataScope", "org");
    validateRoleAndScope(session.principal, role, dataScope);
    const id = await repos.createServiceAccount({
      key,
      name,
      description: stringBody(body, "description", ""),
      orgUnitId: session.principal.orgUnitId,
      role,
      dataScope,
      createdBy: session.principal.id,
    });
    await writeAudit(session, "service_account.create", "service_account", id, { key, role, dataScope });
    return { id };
  });

  app.get("/admin/api/service-accounts/:id", async (request) => {
    const session = await admin(request, "service_account.manage");
    const row = await repos.getServiceAccount(param(request, "id"));
    if (!serviceAccountVisible(session.principal, row)) throw errors.notFound("服务账号不存在");
    return presentServiceAccount(row);
  });

  app.patch("/admin/api/service-accounts/:id", async (request) => {
    const session = await admin(request, "service_account.manage");
    const row = await repos.getServiceAccount(param(request, "id"));
    if (!serviceAccountVisible(session.principal, row)) throw errors.notFound("服务账号不存在");
    const body = bodyOf(request);
    const role = stringBody(body, "role", row.role);
    const dataScope = stringBody(body, "dataScope", row.data_scope);
    if (body.role !== undefined || body.dataScope !== undefined) validateRoleAndScope(session.principal, role, dataScope);
    const status = body.status !== undefined ? stringBody(body, "status") : undefined;
    if (status !== undefined && !SERVICE_ACCOUNT_STATUSES.includes(status)) throw errors.invalid("状态只能是 active 或 disabled");
    const fields = {
      name: body.name !== undefined ? stringBody(body, "name") : undefined,
      description: body.description !== undefined ? stringBody(body, "description") : undefined,
      role: body.role !== undefined ? role : undefined,
      dataScope: body.dataScope !== undefined ? dataScope : undefined,
      status,
    };
    await repos.updateServiceAccount(row.id, fields);
    const before = { name: row.name, description: row.description, role: row.role, dataScope: row.data_scope, status: row.status };
    await writeAudit(session, status === "disabled" ? "service_account.disable" : "service_account.update", "service_account", row.id, { before, changes: fields });
    return { ok: true };
  });
}
