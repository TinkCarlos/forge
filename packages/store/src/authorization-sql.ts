/** Only fixed aliases from repositories are accepted; values always remain bound SQL parameters. */
export function authorizationSql(alias: "users" | "u" | "service_accounts" | "s", type: "user" | "service_account" = "user"): string {
  const applies = `(r.\`key\` = ${alias}.role OR EXISTS (SELECT 1 FROM role_bindings b WHERE b.role_id = r.id AND b.principal_type = '${type}' AND b.principal_id = ${alias}.id AND b.scope_type = 'global' AND b.scope_id = ''))`;
  const permissions = (active: boolean) => `(SELECT COALESCE(JSON_ARRAYAGG(p.\`key\`), JSON_ARRAY()) FROM permissions p WHERE EXISTS (
    SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_key = p.\`key\` AND ${active ? "r.status = 'active' AND" : "r.status <> 'deleted' AND"} ${applies}))`;
  return `JSON_OBJECT('roles', (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('id',r.id,'key',r.\`key\`,'name',r.name,'status',r.status)), JSON_ARRAY()) FROM roles r WHERE r.status <> 'deleted' AND ${applies}),
    'permissions', ${permissions(true)}, 'grantedPermissions', ${permissions(false)}) AS authorization_json`;
}
