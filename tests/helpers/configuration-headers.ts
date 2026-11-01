import { revisionTag } from "@forge/core";
import { repos } from "@forge/store";

/** Existing non-concurrency fixtures read their configuration before writing; REV tests supply explicit captured tags. */
export async function configurationHeaders(url: string, headers: Record<string, string> = {}): Promise<Record<string, string>> {
  if (headers["if-match"] || headers["If-Match"]) return headers;
  const match = /^\/admin\/api\/(agents|skills|mcp|providers|models|apps|users|service-accounts|schedules|plugins)\/([^/]+)(?:\/(versions|publish|refresh|enable|disable|uninstall))?$/.exec(url);
  if (!match) return headers;
  const id = decodeURIComponent(match[2]!);
  const row = await ({ agents: repos.getAgent, skills: repos.getSkill, mcp: repos.getMcpServer, providers: repos.getProviderById, models: repos.getModelById, apps: repos.getApiApp, users: repos.getUserById, "service-accounts": repos.getServiceAccount, schedules: repos.getSchedule, plugins: repos.getPlugin }[match[1]!]!)(id);
  return { ...headers, "if-match": revisionTag(Number(row?.revision ?? 1)) };
}
