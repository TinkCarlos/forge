import type { QueryFilter, QueryScope } from "@forge/core";
export interface BoundFilter { sql: string; params: unknown[] }
export function jobFilterSql(filter: QueryFilter, resource: "definition" | "execution"): BoundFilter {
  const alias = resource === "definition" ? "d" : "e";
  function scope(value: QueryScope, deny = false): BoundFilter {
    const list = (column: string, ids: readonly string[]): BoundFilter => ({ sql: ids.length ? `${column} IN (${ids.map(() => "?").join(",")})` : "FALSE", params: [...ids] });
    switch (value.type) {
      case "intersection": {
        const parts = value.scopes.map(item => scope(item, deny));
        return { sql: parts.length ? parts.map(part => `COALESCE((${part.sql}),FALSE)`).join(" AND ") : "FALSE", params: parts.flatMap(part => part.params) };
      }
      case "all": return { sql: "TRUE", params: [] };
      case "orgs": return list(`${alias}.owner_org_unit_id`, value.ids);
      case "resources": return list(`${alias}.id`, value.ids);
      case "self": return resource === "definition"
        ? value.subjectType === "user" ? { sql: "d.created_by = ?", params: [value.subjectId] } : { sql: deny ? "TRUE" : "FALSE", params: [] }
        : { sql: "(e.subject_type = ? AND e.subject_id = ?)", params: [value.subjectType, value.subjectId] };
      case "app": return resource === "execution" ? { sql: "e.app_id = ?", params: [value.appId] } : { sql: deny ? "TRUE" : "FALSE", params: [] };
    }
  }
  const allow = filter.allow.map(item => scope(item)), deny = filter.deny.map(item => scope(item, true)), ceiling = scope(filter.ceiling);
  return {
    sql: `(${allow.map(item => `COALESCE((${item.sql}),FALSE)`).join(" OR ") || "FALSE"}) AND NOT (${deny.map(item => `COALESCE((${item.sql}),FALSE)`).join(" OR ") || "FALSE"}) AND COALESCE((${ceiling.sql}),FALSE)`,
    params: [...allow.flatMap(item => item.params), ...deny.flatMap(item => item.params), ...ceiling.params],
  };
}
