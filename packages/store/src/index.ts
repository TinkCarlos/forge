import { identityRepo } from "./repositories/identity.js";
import { openPlatformRepo } from "./repositories/openplatform.js";
import { agentsRepo } from "./repositories/agents.js";
import { capabilitiesRepo } from "./repositories/capabilities.js";
import { runsRepo } from "./repositories/runs.js";
import { schedulesRepo } from "./repositories/schedules.js";
import { auditRepo } from "./repositories/audit.js";

export * from "./db.js";
export * from "./types.js";

export const repos = {
  ...identityRepo,
  ...openPlatformRepo,
  ...agentsRepo,
  ...capabilitiesRepo,
  ...runsRepo,
  ...schedulesRepo,
  ...auditRepo,
};
