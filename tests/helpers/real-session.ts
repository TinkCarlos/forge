import { randomBytes } from "node:crypto";
import type { Principal } from "@forge/core";
import { createSession, destroySession, type Session } from "@forge/identity";
import { execute, repos } from "@forge/store";

// Sessions only store the user id and re-read the principal from the database on every request (S-38), so a test
// session needs a real, active user row. realSession() creates one with the requested role / department / data scope
// (and the department itself when the test uses an id that does not exist yet); cleanupRealSessions() removes them.
const createdUsers: string[] = [];
const createdOrgs: string[] = [];
const sessions: Session[] = [];

export async function realSession(principal: Pick<Principal, "role" | "orgUnitId" | "dataScope"> & { name?: string }): Promise<Session> {
  const tag = randomBytes(6).toString("hex");
  if (principal.orgUnitId && !(await repos.getOrgUnit(principal.orgUnitId))) {
    await execute("INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, NULL, ?, ?, ?)", [principal.orgUnitId, `it-rs-${tag}`, "IT test org", `/it-rs-${tag}/`]);
    createdOrgs.push(principal.orgUnitId);
  }
  const name = principal.name ?? `IT ${principal.role}`;
  const id = await repos.createUser({ email: `it-rs-${tag}@forge.local`, username: `it-rs-${tag}`, displayName: name, role: principal.role, dataScope: principal.dataScope, orgUnitId: principal.orgUnitId });
  createdUsers.push(id);
  const session = await createSession({ type: "user", id, name, role: principal.role, orgUnitId: principal.orgUnitId, dataScope: principal.dataScope });
  sessions.push(session);
  return session;
}

export const sessionHeaders = (session: Session, cookieValue: string): Record<string, string> => ({ cookie: `forge_session=${cookieValue}`, "x-csrf-token": session.csrfToken });

export async function cleanupRealSessions(): Promise<void> {
  for (const session of sessions.splice(0)) await destroySession(session.token);
  for (const id of createdUsers.splice(0)) {
    await execute("DELETE FROM audit_logs WHERE actor_id = ?", [id]);
    await execute("DELETE FROM users WHERE id = ?", [id]);
  }
  for (const id of createdOrgs.splice(0)) await execute("DELETE FROM org_units WHERE id = ?", [id]);
}
