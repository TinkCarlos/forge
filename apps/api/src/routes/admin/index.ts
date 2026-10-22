import type { FastifyInstance } from "fastify";
import adminAgentRoutes from "./agents.js";
import adminModelRoutes from "./models.js";
import adminCapabilityRoutes from "./capabilities.js";
import adminRunRoutes from "./runs.js";
import adminScheduleRoutes from "./schedules.js";
import adminAppRoutes from "./apps.js";
import adminIdentityRoutes from "./identity.js";
import adminPluginRoutes from "./plugins.js";
import adminServiceAccountRoutes from "./service-accounts.js";

// All /admin/api/* console routes. Session + permission checks live in each handler via admin().
export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  await app.register(adminAgentRoutes);
  await app.register(adminModelRoutes);
  await app.register(adminCapabilityRoutes);
  await app.register(adminRunRoutes);
  await app.register(adminScheduleRoutes);
  await app.register(adminAppRoutes);
  await app.register(adminIdentityRoutes);
  await app.register(adminPluginRoutes);
  await app.register(adminServiceAccountRoutes);
}
