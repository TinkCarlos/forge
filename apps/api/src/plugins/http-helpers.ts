import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  asRecord,
  asString,
  config,
  errors,
  parseJson,
  ROLE_PERMISSIONS,
  type Principal,
} from "@forge/core";
import { assertOrgWritable, assertPermission, maskArgsDeep, visibleAgentOrgIds } from "@forge/governance";
import { sessionCookieOptions } from "./session-cookie.js";
import { oidcConfigured, readSignedSessionCookie, readStoredSessionCookie, sessionCookieValue, type Session, type StoredSession } from "@forge/identity";
import {
  assertDeleteAuditOrgUnit,
  parseJsonValue,
  repos,
  type AgentRow,
  type AgentVersionRow,
  type RunRow,
} from "@forge/store";

// Shared request/response helpers used by every route domain.

export function reqId(request: FastifyRequest): string {
  return String(request.id);
}

export function bodyOf(request: FastifyRequest): Record<string, unknown> {
  return asRecord(request.body);
}

export function param(request: FastifyRequest, key: string): string {
  return String((request.params as Record<string, unknown>)[key] ?? "");
}

export function stringBody(body: Record<string, unknown>, key: string, fallback = ""): string {
  return asString(body[key], fallback);
}

/**
 * Enumerated body field (status whitelists, T / K-12): undefined when absent; otherwise must be one of `allowed`
 * (exact, case-sensitive string) or 400 CFG-8501. Never coerces, so a typo cannot silently become another state.
 */
export function enumBody<T extends string>(body: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw errors.invalid(`${key} 只能是 ${allowed.join(" 或 ")}`);
  }
  return value as T;
}

export function arrayBody(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function jsonBody(body: Record<string, unknown>, key: string, fallback: unknown): unknown {
  const value = body[key];
  if (typeof value === "string") return parseJson(value, fallback);
  return value ?? fallback;
}

/** Session with the principal re-read from the database (one query); null when missing/expired or the user is no longer usable. */
export async function readSession(request: FastifyRequest): Promise<Session | null> {
  return readSignedSessionCookie(request.cookies.forge_session);
}

/** Stored session only (no database access): for the CSRF check and logout. */
export function readStoredSession(request: FastifyRequest): StoredSession | null {
  return readStoredSessionCookie(request.cookies.forge_session);
}

export async function admin(request: FastifyRequest, permission?: string): Promise<Session> {
  const session = await readSession(request);
  if (!session) throw errors.unauthorized();
  if (permission) assertPermission(session.principal, permission);
  return session;
}

export function setSessionCookie(reply: FastifyReply, session: Session): void {
  reply.setCookie("forge_session", sessionCookieValue(session), sessionCookieOptions(config));
}

export async function writeAudit(
  session: Session,
  action: string,
  resourceType: string,
  resourceId: string | null,
  details?: unknown,
  opts: { orgUnitId?: string | null } = {},
): Promise<void> {
  // I-SCOPE plan A: the row records the resource's department (resolved in repos.audit unless opts.orgUnitId is given).
  await repos.audit({ actorType: "user", actorId: session.principal.id, action, resourceType, resourceId, details, ...(opts.orgUnitId !== undefined ? { orgUnitId: opts.orgUnitId } : {}) });
}

/**
 * P2 (QA 714b3f3 §4): builds and validates an audit entry BEFORE the change it records (delete-class guard: explicit
 * orgUnitId, null for platform-level resources), and returns the writer to call after the change. A guard failure
 * then aborts the request before anything is changed.
 */
export function prepareAudit(
  session: Session,
  action: string,
  resourceType: string,
  resourceId: string | null,
  details?: unknown,
  opts: { orgUnitId?: string | null } = {},
): () => Promise<void> {
  assertDeleteAuditOrgUnit({ action, ...opts });
  return () => writeAudit(session, action, resourceType, resourceId, details, opts);
}

export async function agentAccessible(principal: Principal, agent: AgentRow | null): Promise<boolean> {
  if (!agent) return false;
  if (!agent.owner_org_unit_id) return true;
  const orgIds = await visibleAgentOrgIds(principal);
  return orgIds === null || orgIds.includes(agent.owner_org_unit_id);
}

/**
 * Write paths only (I-AGT-13): call after agentAccessible. An Agent without an owner department is readable / runnable
 * by everyone in scope, but only a dataScope=all principal may change it (PATCH, new version, publish); others 403 POL-2001.
 */
export async function assertAgentWritable(principal: Principal, agent: AgentRow): Promise<void> {
  // P3-17: same rule as P0-03 platform resources (assertOrgWritable with no department -> only an effective
  // dataScope=all covers it), not the role name.
  if (!agent.owner_org_unit_id) await assertOrgWritable(principal, null, "无主 Agent 仅数据范围为全部（all）的管理员可修改");
}

/**
 * P1 (U-12 follow-up): run output leaving the server, in every API (admin, open, integration; run DTO, /result and the
 * open invoke wait body). Same structured rules as input and tool results (maskArgsDeep); the stored row is unchanged.
 */
export function presentRunOutput(output: unknown): unknown {
  return maskArgsDeep(output);
}

/** Run DTO shared by admin, open and integration APIs. `input` and `output` are masked (maskArgsDeep); the stored row is unchanged. */
export function presentRun(run: RunRow) {
  return {
    id: run.id,
    threadId: run.thread_id,
    agentId: run.agent_id,
    agentVersionId: run.agent_version_id,
    appId: run.app_id,
    orgUnitId: run.org_unit_id,
    status: run.status,
    triggerType: run.trigger_type,
    triggerRef: run.trigger_ref,
    input: maskArgsDeep(run.input_json),
    output: presentRunOutput(run.output_json),
    usage: run.usage_json,
    costUsd: Number(run.cost_usd),
    errorCode: run.error_code,
    errorMessage: run.error_message,
    createdAt: run.created_at,
    startedAt: run.started_at,
    completedAt: run.completed_at,
  };
}

export function presentAgent(agent: AgentRow, version?: AgentVersionRow | null) {
  return {
    id: agent.id,
    key: agent.key,
    name: agent.name,
    description: agent.description,
    status: agent.status,
    ownerOrgUnitId: agent.owner_org_unit_id,
    apiEnabled: Boolean(agent.api_enabled),
    publishedVersionId: agent.published_version_id,
    publishedVersion: version?.version ?? null,
    createdAt: agent.created_at,
  };
}

export function requireBodyString(body: Record<string, unknown>, key: string): string {
  const value = stringBody(body, key).trim();
  if (!value) throw errors.invalid(`缺少字段: ${key}`);
  return value;
}

/**
 * P1: every event leaves the SSE stream masked like REST, with the run-output mask (maskArgsDeep via presentRunOutput),
 * including rows written before message events were masked at write time (no backfill; the stored row is unchanged).
 * message.delta rows written by the current runtime are flagged `masked: true` (masked over the accumulated message,
 * see createStreamMasker) and are not masked again piecewise; the flag is not sent.
 */
export function presentEventData(type: string, data: unknown): unknown {
  if (type === "message.delta" && data !== null && typeof data === "object" && !Array.isArray(data) && (data as Record<string, unknown>).masked === true) {
    const { masked: _masked, ...rest } = data as Record<string, unknown>;
    return rest;
  }
  return presentRunOutput(data);
}

/**
 * P1 replay: a message.delta followed (in the same batch) by a message.completed belongs to a message that is already
 * complete; only the masked full message is sent, not its fragments.
 */
export function replayableEvents<T extends { type: string }>(events: T[]): T[] {
  let lastCompleted = -1;
  events.forEach((event, index) => {
    if (event.type === "message.completed") lastCompleted = index;
  });
  return events.filter((event, index) => !(event.type === "message.delta" && index < lastCompleted));
}

export async function streamRun(request: FastifyRequest, reply: FastifyReply, runId: string): Promise<void> {
  const header = request.headers["last-event-id"];
  let lastSeq = Number(Array.isArray(header) ? header[0] : header ?? 0) || 0;
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": forge stream\n\n");
  let closed = false;
  let heartbeat = 0;
  const poll = async (): Promise<void> => {
    if (closed) return;
    try {
      const events = await repos.listEvents(runId, lastSeq);
      for (const event of events) lastSeq = Math.max(lastSeq, Number(event.seq));
      for (const event of replayableEvents(events)) {
        const data = JSON.stringify({
          type: event.type,
          seq: event.seq,
          runId,
          ts: new Date(event.created_at).toISOString(),
          data: presentEventData(event.type, parseJsonValue(event.data_json, {})),
        });
        reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${data}\n\n`);
      }
      const run = await repos.getRun(runId);
      if (run && ["succeeded", "failed", "cancelled", "budget_exhausted"].includes(run.status) && events.length === 0) {
        closed = true;
        reply.raw.end();
        clearInterval(timer);
      }
    } catch {
      closed = true;
      reply.raw.end();
      clearInterval(timer); // P3-06: no further polls after a failure
    }
    heartbeat += 1;
    if (!closed && heartbeat % 15 === 0) reply.raw.write(": heartbeat\n\n");
  };
  const timer = setInterval(() => void poll(), 500);
  request.raw.on("close", () => {
    closed = true;
    clearInterval(timer);
  });
  await poll();
}

export function sessionPayload(session: Session) {
  return {
    user: {
      id: session.principal.id,
      name: session.principal.name,
      role: session.principal.role,
      orgUnitId: session.principal.orgUnitId,
      dataScope: session.principal.dataScope,
    },
    permissions: session.principal.role === "platform_admin" ? ["*"] : ROLE_PERMISSIONS[session.principal.role],
    csrfToken: session.csrfToken,
    oidcConfigured: oidcConfigured(),
    localLogin: config.ALLOW_LOCAL_LOGIN,
  };
}
