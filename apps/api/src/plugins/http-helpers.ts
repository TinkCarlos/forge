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
import { assertPermission, visibleAgentOrgIds } from "@forge/governance";
import { oidcConfigured, readSignedSessionCookie, sessionCookieValue, type Session } from "@forge/identity";
import {
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

export function arrayBody(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function jsonBody(body: Record<string, unknown>, key: string, fallback: unknown): unknown {
  const value = body[key];
  if (typeof value === "string") return parseJson(value, fallback);
  return value ?? fallback;
}

export function readSession(request: FastifyRequest): Session | null {
  return readSignedSessionCookie(request.cookies.forge_session);
}

export async function admin(request: FastifyRequest, permission?: string): Promise<Session> {
  const session = readSession(request);
  if (!session) throw errors.unauthorized();
  if (permission) assertPermission(session.principal, permission);
  return session;
}

export function setSessionCookie(reply: FastifyReply, session: Session): void {
  reply.setCookie("forge_session", sessionCookieValue(session), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
}

export async function writeAudit(
  session: Session,
  action: string,
  resourceType: string,
  resourceId: string | null,
  details?: unknown,
): Promise<void> {
  await repos.audit({ actorType: "user", actorId: session.principal.id, action, resourceType, resourceId, details });
}

export async function agentAccessible(principal: Principal, agent: AgentRow | null): Promise<boolean> {
  if (!agent) return false;
  if (!agent.owner_org_unit_id) return true;
  const orgIds = await visibleAgentOrgIds(principal);
  return orgIds === null || orgIds.includes(agent.owner_org_unit_id);
}

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
    input: run.input_json,
    output: run.output_json,
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
      for (const event of events) {
        lastSeq = Number(event.seq);
        const data = JSON.stringify({
          type: event.type,
          seq: event.seq,
          runId,
          ts: new Date(event.created_at).toISOString(),
          data: parseJsonValue(event.data_json, {}),
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
