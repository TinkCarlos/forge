import { config, hashPassword } from "@forge/core";
import { execute, one, query } from "@forge/store";

const ROOT_ORG = "01J00000000000000000000000";
const ADMIN_ID = "01J00000000000000000000001";
const PROVIDER_ID = "01J00000000000000000000002";
const MODEL_ID = "01J00000000000000000000003";
const SKILL_ID = "01J00000000000000000000004";
const SKILL_VERSION_ID = "01J00000000000000000000005";
const AGENT_ID = "01J00000000000000000000006";
const AGENT_VERSION_ID = "01J00000000000000000000007";

await execute(
  "INSERT INTO org_units (id, parent_id, `key`, name, path) VALUES (?, NULL, 'root', 'Forge', '/') ON DUPLICATE KEY UPDATE name = VALUES(name)",
  [ROOT_ORG],
);

const admin = await one<{ id: string }>("SELECT id FROM users WHERE email = ?", [config.FORGE_ADMIN_EMAIL]);
if (!admin) {
  await execute(
    "INSERT INTO users (id, username, email, display_name, password_hash, role, data_scope, org_unit_id, is_emergency_admin) VALUES (?, ?, ?, ?, ?, 'platform_admin', 'all', ?, 1)",
    [ADMIN_ID, "admin", config.FORGE_ADMIN_EMAIL, config.FORGE_ADMIN_NAME, hashPassword(config.FORGE_ADMIN_PASSWORD), ROOT_ORG],
  );
  console.log(`Seeded local admin ${config.FORGE_ADMIN_EMAIL}`);
} else {
  await execute("UPDATE users SET password_hash = ?, role = 'platform_admin', data_scope = 'all', org_unit_id = ? WHERE id = ?", [hashPassword(config.FORGE_ADMIN_PASSWORD), ROOT_ORG, admin.id]);
}

await execute(
  `INSERT INTO llm_providers (id, \`key\`, name, protocol, base_url, status)
   VALUES (?, 'mock', 'Mock Provider (offline demo)', 'mock', 'mock://local', 'active')
   ON DUPLICATE KEY UPDATE name = VALUES(name), protocol = VALUES(protocol), base_url = VALUES(base_url), status = 'active'`,
  [PROVIDER_ID],
);

await execute(
  `INSERT INTO llm_models (id, provider_id, \`key\`, display_name, capabilities_json, context_window, max_output_tokens)
   VALUES (?, ?, 'mock-1', 'Mock 1 (offline)', ?, 32768, 4096)
   ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), capabilities_json = VALUES(capabilities_json)`,
  [MODEL_ID, PROVIDER_ID, JSON.stringify(["text", "tools"])],
);

const skillContent = `---
name: forge-demo-skill
description: Forge 内置演示技能
version: 1.0.0
---

# Forge 演示技能

当用户询问 Forge 能力时，简洁说明：Forge 支持可插拔 Agent、MCP、Skill、开放 API、数据权限与定时任务。
`;
await execute(
  `INSERT INTO skills (id, \`key\`, name, description, status, latest_version_id, published_version_id)
   VALUES (?, 'forge-demo-skill', 'Forge 演示技能', '内置演示技能', 'active', ?, ?)
   ON DUPLICATE KEY UPDATE name = VALUES(name), latest_version_id = VALUES(latest_version_id), published_version_id = VALUES(published_version_id)`,
  [SKILL_ID, SKILL_VERSION_ID, SKILL_VERSION_ID],
);
await execute(
  `INSERT INTO skill_versions (id, skill_id, version, status, content_md, published_at)
   VALUES (?, ?, '1.0.0', 'published', ?, CURRENT_TIMESTAMP(3))
   ON DUPLICATE KEY UPDATE content_md = VALUES(content_md), status = 'published'`,
  [SKILL_VERSION_ID, SKILL_ID, skillContent],
);

const instructions = "你是 Forge 演示助手。回答简洁、可执行。涉及外部副作用时先说明将调用什么工具。";
const spec = {
  model: { provider: "mock", model: "mock-1", temperature: 0.2 },
  skills: ["forge-demo-skill"],
  toolsets: [{ builtin: ["current_time", "echo"] }],
  limits: { maxSteps: 4, maxCostUsd: 1 },
  approval: { tools: [] },
};

await execute(
  `INSERT INTO agents (id, \`key\`, name, description, status, owner_org_unit_id, latest_version_id, published_version_id, created_by)
   VALUES (?, 'demo-agent', 'Forge 演示助手', '无需外部模型即可运行的演示 Agent', 'active', ?, ?, ?, ?)
   ON DUPLICATE KEY UPDATE name = VALUES(name), published_version_id = VALUES(published_version_id), latest_version_id = VALUES(latest_version_id)`,
  [AGENT_ID, ROOT_ORG, AGENT_VERSION_ID, AGENT_VERSION_ID, ADMIN_ID],
);
await execute(
  `INSERT INTO agent_versions (id, agent_id, version, status, instructions, spec_json, changelog, created_by, published_at)
   VALUES (?, ?, '1.0.0', 'published', ?, ?, '初始演示版本', ?, CURRENT_TIMESTAMP(3))
   ON DUPLICATE KEY UPDATE instructions = VALUES(instructions), spec_json = VALUES(spec_json), status = 'published'`,
  [AGENT_VERSION_ID, AGENT_ID, instructions, JSON.stringify(spec), ADMIN_ID],
);

const mappings: Array<[string, string, string]> = [
  ["admin", "Administrator", "platform_admin"],
  ["builder", "Builder", "builder"],
  ["operator", "Operator", "operator"],
  ["auditor", "Auditor", "auditor"],
  ["user", "User", "user"],
];
for (let index = 0; index < mappings.length; index += 1) {
  const [code, name, role] = mappings[index]!;
  const mappingId = `01J000000000000000000000${String(10 + index).padStart(2, "0")}`.slice(0, 26);
  await execute(
    "INSERT INTO oidc_role_mappings (id, agent_role_code, agent_role_name, local_role) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE local_role = VALUES(local_role)",
    [mappingId, code, name, role],
  );
}

await execute(
  "INSERT INTO settings (`key`, value_json) VALUES ('sso', ?) ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)",
  [JSON.stringify({ mode: config.SSO_MODE, tokenValidationMode: config.SSO_TOKEN_VALIDATION_MODE, roleMappingRequired: config.SSO_ROLE_MAPPING_REQUIRED })],
);

const counts = await query<{ users: number }>("SELECT COUNT(*) AS users FROM users");
console.log(`Seed complete. Users: ${counts[0]?.users ?? 0}. Demo agent: demo-agent. Provider: mock.`);
process.exit(0);
