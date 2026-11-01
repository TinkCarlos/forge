export type QueryScope =
  | { type: "intersection"; scopes: readonly QueryScope[] }
  | { type: "all" }
  | { type: "orgs"; ids: readonly string[] }
  | { type: "self"; subjectType: "user" | "service" | "app"; subjectId: string }
  | { type: "app"; appId: string }
  | { type: "resources"; ids: readonly string[] };

/** Produced from current trusted policies; allow union minus deny, intersected with the caller ceiling. */
export interface QueryFilter {
  allow: readonly QueryScope[];
  deny: readonly QueryScope[];
  ceiling: QueryScope;
}
