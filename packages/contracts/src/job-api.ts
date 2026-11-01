import {boundedHttpSchema} from "./http-schema.js";
import { z } from "zod";
import { JOB_ID_SCHEMA, JOB_NAME_SCHEMA, JOB_KEY_SCHEMA, jobText } from "./job-messaging.js";
import type { JobManifest } from "./job-definitions.js";
export interface JobDetail {
  id: string; key: string; name: string; description: string; businessType: string; orgUnitId: string | null;
  responsibleUserId: string | null; status: string; revision: number; publishedVersionId: string | null;
  allowedActions: ("manage" | "publish")[]; draft?: JobManifest; createdAt: string; updatedAt: string;
}
export interface JobTarget {
  kind: "agent"; key: string; version: string; checksum: string; name: string;
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  runtimeEngine: "mysql-agent-bridge"; snapshotQuality: "legacy";
}
export interface JobVersionDetail { id: string; jobId: string; version: number; manifestHash: string; createdAt: string }
export const JOB_LIST_QUERY_SCHEMA = z.object({
  limit: z.string().regex(/^(?:[1-9][0-9]?|1[0-9]{2}|200)$/).optional(), cursor: z.string().max(2048).optional(),
  status: z.enum(["active", "disabled"]).optional(), businessType: jobText(1, 64).optional(), orgUnitId: JOB_ID_SCHEMA.optional(),
}).strict();
// Detailed semantic checks run against JOB_CREATE/PATCH_SCHEMA after the HTTP structural check.
const fields = {
  name: { type: "string", minLength: 1, maxLength: 256 }, description: { type: "string", maxLength: 2048 },
  businessType: { type: "string", minLength: 1, maxLength: 128 },
  orgUnitId: { type: ["string", "null"], maxLength: 26 }, responsibleUserId: { type: ["string", "null"], maxLength: 26 },
  draft: { type: "object" }, status: { type: "string",maxLength:8, enum: ["active", "disabled"] },
};
export const JOB_HTTP_SCHEMAS = {
  create: { body: { type: "object", additionalProperties: false, required: ["key", "name", "businessType", "draft"], properties: { key: { type: "string", maxLength:65536 }, ...fields } } },
  patch: { body: { type: "object", additionalProperties: false, properties: fields } },
  empty: { body: { type: "object", additionalProperties: false, properties: {} } },
  list: { querystring: boundedHttpSchema(z.toJSONSchema(JOB_LIST_QUERY_SCHEMA, { target: "draft-7" })) },
};
export const JOB_DETAIL_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["id", "key", "name", "description", "businessType", "orgUnitId", "responsibleUserId", "status", "revision", "publishedVersionId", "createdAt", "updatedAt", "allowedActions"],
  properties: { id: { type: "string" }, key: z.toJSONSchema(JOB_KEY_SCHEMA), name: z.toJSONSchema(JOB_NAME_SCHEMA, { unrepresentable: "any" }),
    description: { type: "string" }, businessType: { type: "string" }, orgUnitId: { type: ["string", "null"] }, responsibleUserId: { type: ["string", "null"] },
    status: { enum: ["active", "disabled"] }, revision: { type: "integer", minimum: 1 }, publishedVersionId: { type: ["string", "null"] },
    allowedActions: {type:"array",items:{enum:["manage","publish"]}}, draft: { type: "object" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } },
};
