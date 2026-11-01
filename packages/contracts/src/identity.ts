import { z } from "zod";
const text = (maxLength: number, minLength = 1) => ({ type: "string", minLength, maxLength }) as const;
const object = <T extends Record<string, unknown>>(properties: T, required: readonly string[] = []) => ({ type: "object", additionalProperties: false, properties, required }) as const;
const password = text(256, 8);
const nullableId = { type: ["string", "null"], maxLength: 26, minLength: 26 } as const;
const email = { ...text(255), pattern: "^\\s*[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\s*$" } as const;
export const ADDITIONAL_ROLE_IDS = { type:"array", maxItems:32, uniqueItems:true, items:text(26,26) } as const;
const userProperties = { additionalRoleIds:ADDITIONAL_ROLE_IDS, email, username: text(64), displayName: text(128), role: text(32), dataScope: text(16), status: { type: "string", maxLength: 16, enum: ["active", "disabled"] }, orgUnitId: nullableId } as const;
export const USER_CREATE_BODY = object({ ...userProperties, password }, ["email"]);
export const USER_PATCH_BODY = object(userProperties);
export const USER_PASSWORD_BODY = object({ password }, ["password"]);
export const USER_SSO_BINDING_BODY = object({ subject: text(255) }, ["subject"]);
export const AUTH_PASSWORD_BODY = object({ currentPassword: text(256), newPassword: password }, ["currentPassword", "newPassword"]);
const page = { limit: { type: "string", maxLength: 3, pattern: "^(?:[1-9][0-9]?|1[0-9]{2}|200)$" }, cursor: text(512) } as const;
export const USER_LIST_QUERY = object({ ...page, q: text(255, 0), status: { type: "string", maxLength: 16, enum: ["active", "disabled"] } });
export const AUDIT_LIST_QUERY = object({ ...page, action: text(64), resourceType: text(32), resourceId: text(26), actorId: text(26), outcome: { type: "string", maxLength: 16, enum: ["success", "failure", "denied"] }, from: text(35), to: text(35) });

export interface UserDto {
  id: string; revision: number; username: string; email: string; display_name: string; role: string;
  data_scope: string; org_unit_id: string | null; status: string; created_at: Date | string; updated_at: Date | string;
  roles: import("@forge/core").AuthorizationRole[]; additional_role_ids:string[]; effective_permissions:string[];
  has_local_password: boolean; can_manage: boolean; idp_subject?: string | null; idp_issuer?: string | null; is_emergency_admin?: boolean;
}
export interface PageQuery { limit?: number; cursor?: string }
export interface UserListQuery extends PageQuery { q?: string; status?: string }
export interface AuditListQuery extends PageQuery { action?: string; resourceType?: string; resourceId?: string; actorId?: string; outcome?: string; from?: string; to?: string }
export interface PageResult<T> { items: T[]; nextCursor: string | null }

export function isAuditTimestamp(value: unknown): boolean { return z.iso.datetime({ offset: true }).safeParse(value).success; }
