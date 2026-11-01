import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { config, decryptLegacySecret, encryptSecret, loadMasterKeyring } from "@forge/core";
import { execute, migrateResourceCredentials, one, query, repos, rewrapSecretVersion } from "@forge/store";
import { auditRepo } from "../packages/store/src/repositories/audit.js";

const resources: Array<{ type: "llm_provider" | "api_app" | "mcp_server" | "tool_source"; id: string }> = [], secrets: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "forge-secret-maint-")), keyFile = join(dir, "keyring.json");
const previous = config.FORGE_MASTER_KEYRING_FILE;
const key2 = randomBytes(32).toString("base64");
const target = async (type: typeof resources[number]["type"]) => {
  const key = `it-sm-${randomUUID()}`, base = { key, name: key };
  const id = type === "llm_provider" ? await repos.createProvider({ ...base, protocol: "openai-compatible", baseUrl: "https://llm.example/v1" })
    : type === "mcp_server" ? await repos.createMcpServer({ ...base, url: "https://mcp.example/mcp" })
    : type === "tool_source" ? await repos.createToolSource({ ...base, baseUrl: "https://api.example", spec: {} })
    : await repos.createApiApp({ ...base, scopes: [] });
  resources.push({ type, id }); return id;
};
const resetKeyFile = () => { config.FORGE_MASTER_KEYRING_FILE = previous; };
afterAll(async () => {
  resetKeyFile(); vi.restoreAllMocks();
  for (const { type, id } of resources) {
    const refs = await query<{ to_id: string }>("SELECT to_id FROM resource_references WHERE from_type = ? AND from_id = ?", [type, id]); secrets.push(...refs.map(r => r.to_id));
    await execute("DELETE FROM resource_references WHERE from_type = ? AND from_id = ?", [type, id]);
    const table = { llm_provider: "llm_providers", api_app: "api_apps", mcp_server: "mcp_servers", tool_source: "tool_sources" }[type];
    await execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
  }
  for (const id of new Set(secrets)) { await execute("DELETE FROM secret_versions WHERE secret_id = ?", [id]); await execute("DELETE FROM secrets WHERE id = ?", [id]); }
  rmSync(dir, { recursive: true, force: true });
});

describe("SEC08 legacy migration preserves data and is restartable", () => {
  it("also encrypts soft-deleted MCP history without making it usable again", async () => {
    const id = await target("mcp_server"), value = "deleted-but-still-secret";
    await execute("UPDATE mcp_servers SET headers_json = ?, header_secret_refs_json = NULL, deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [JSON.stringify({"X-Token":value}), id]);
    expect(await migrateResourceCredentials("mcp_server", id)).toBe(true);
    expect(await repos.getCredentialResource("mcp_server", id)).toBeNull();
    const row = await one<{ headers_json: unknown; header_secret_refs_json: Record<string, string>; deleted_at: Date }>("SELECT headers_json, header_secret_refs_json, deleted_at FROM mcp_servers WHERE id = ?", [id]);
    expect(JSON.stringify(row)).not.toContain(value); expect(row!.deleted_at).toBeTruthy();
    await expect(repos.resolveCredentialValues("mcp_server", id, { "header:x-token": row!.header_secret_refs_json["x-token"]! })).rejects.toMatchObject({code:"SYS-9002"});
    expect(await migrateResourceCredentials("mcp_server", id)).toBe(false);
  });
  it.each(["llm_provider", "mcp_server", "tool_source", "api_app"] as const)("migrates %s atomically, masks stored data and does not duplicate on rerun", async type => {
    const id = await target(type), secret = "synthetic-legacy-credential";
    const table = { llm_provider: "llm_providers", api_app: "api_apps", mcp_server: "mcp_servers", tool_source: "tool_sources" }[type];
    if (type === "api_app") await execute("UPDATE api_apps SET webhook_secret_encrypted = ? WHERE id = ?", [encryptSecret(secret, config.FORGE_MASTER_KEY), id]);
    else await execute(`UPDATE ${table} SET headers_json = ?, header_secret_refs_json = NULL${type === "llm_provider" ? ", api_key_encrypted = ?" : ""} WHERE id = ?`, [JSON.stringify({ "X-Custom": secret, "X-Empty": "" }), ...(type === "llm_provider" ? [encryptSecret(secret, config.FORGE_MASTER_KEY)] : []), id]);
    const before = await one<{ revision: number }>(`SELECT revision FROM ${table} WHERE id = ?`, [id]);
    expect(await migrateResourceCredentials(type, id)).toBe(true);
    const after = await one<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    expect(after!.revision).toBe(before!.revision + 1); expect(JSON.stringify(after)).not.toContain(secret);
    const refs = await query<{ binding_key: string; to_id: string }>("SELECT binding_key, to_id FROM resource_references WHERE from_type = ? AND from_id = ?", [type, id]);
    expect(refs.length).toBe(type === "llm_provider" ? 2 : 1);
    expect(Object.values(await repos.resolveCredentialValues(type, id, Object.fromEntries(refs.map(r => [r.binding_key, r.to_id]))))).toEqual(refs.map(() => secret));
    expect(await migrateResourceCredentials(type, id)).toBe(false);
    expect((await one<{ revision: number }>(`SELECT revision FROM ${table} WHERE id = ?`, [id]))!.revision).toBe(after!.revision);
  });
  it("retains the exact original row on bad ciphertext, invalid headers or failed audit", async () => {
    const id = await target("llm_provider");
    const assertUnchanged = async () => {
      const before = await one("SELECT * FROM llm_providers WHERE id = ?", [id]);
      await expect(migrateResourceCredentials("llm_provider", id)).rejects.toBeDefined();
      expect(await one("SELECT * FROM llm_providers WHERE id = ?", [id])).toEqual(before);
      expect(await query("SELECT id FROM resource_references WHERE from_id = ?", [id])).toHaveLength(0);
    };
    await execute("UPDATE llm_providers SET api_key_encrypted = ?, headers_json = ?, header_secret_refs_json = NULL WHERE id = ?", ["v1.bad.bad.bad", JSON.stringify({ "X-Token": "kept-original" }), id]);
    await assertUnchanged();
    await execute("UPDATE llm_providers SET api_key_encrypted = NULL, headers_json = ? WHERE id = ?", [JSON.stringify({ "X-Token": "env:FORGE_MASTER_KEY" }), id]);
    await assertUnchanged();
    await execute("UPDATE llm_providers SET headers_json = ? WHERE id = ?", [JSON.stringify({ "X-Token": "kept-original" }), id]);
    const audit = vi.spyOn(auditRepo, "audit").mockRejectedValueOnce(Error("audit down"));
    await assertUnchanged(); audit.mockRestore();
    expect(await migrateResourceCredentials("llm_provider", id)).toBe(true);
  });
});

describe("SEC09 rewraps every retained version without changing the credential", () => {
  it("preserves data bytes and revision, is idempotent and reads after retiring the old key", async () => {
    const id = await target("api_app"), s = await repos.createSecret({ key: `it-sm-${randomUUID()}`, name: "rewrap", scope: { type: "resource", resourceType: "api_app", id }, orgUnitId: null, value: "first" }); secrets.push(s.id);
    await repos.rotateSecret(s.id, "second", { expectedRevision: 1 });
    await repos.updateApiApp(id, { webhook_secret_id: s.id }, { expectedRevision: "system" });
    const before = await query<{ id: string; ciphertext: Buffer; nonce: Buffer; tag: Buffer }>("SELECT id, ciphertext, nonce, tag FROM secret_versions WHERE secret_id = ? ORDER BY version", [s.id]);
    writeFileSync(keyFile, JSON.stringify({ activeVersion: "new", keys: { legacy: config.FORGE_MASTER_KEY.trim(), new: key2 } }), { mode: 0o600 }); config.FORGE_MASTER_KEYRING_FILE = keyFile;
    try {
      for (const row of before) { expect(await rewrapSecretVersion(row.id, "new")).toBe(true); expect(await rewrapSecretVersion(row.id, "new")).toBe(false); }
      expect(await query("SELECT id, ciphertext, nonce, tag FROM secret_versions WHERE secret_id = ? ORDER BY version", [s.id])).toEqual(before);
      expect((await repos.getSecret(s.id, { all: true }))!.revision).toBe(2);
      writeFileSync(keyFile, JSON.stringify({ activeVersion: "new", keys: { new: key2 } }));
      expect(await repos.resolveCredentialValues("api_app", id, { webhook: s.id })).toEqual({ webhook: "second" });
      expect(() => decryptLegacySecret(encryptSecret("old", config.FORGE_MASTER_KEY), loadMasterKeyring(config))).toThrow(expect.objectContaining({ code: "SYS-9002" }));
      await expect(rewrapSecretVersion(before[0]!.id, "different-active-version")).rejects.toMatchObject({ code: "SYS-9002" });
    } finally { resetKeyFile(); }
  });
  it("fails without altering a damaged version or committing a failed audit", async () => {
    const s = await repos.createSecret({ key: `it-sm-${randomUUID()}`, name: "rewrap failure", scope: { type: "platform" }, orgUnitId: null, value: "unchanged" }); secrets.push(s.id);
    const before = await one<{ id: string; tag: Buffer }>("SELECT * FROM secret_versions WHERE secret_id = ?", [s.id]);
    writeFileSync(keyFile, JSON.stringify({ activeVersion: "new", keys: { legacy: config.FORGE_MASTER_KEY.trim(), new: key2 } }), { mode: 0o600 }); config.FORGE_MASTER_KEYRING_FILE = keyFile;
    try {
      const audit = vi.spyOn(auditRepo, "audit").mockRejectedValueOnce(Error("audit down"));
      await expect(rewrapSecretVersion(before!.id, "new")).rejects.toThrow(); audit.mockRestore();
      expect(await one("SELECT * FROM secret_versions WHERE id = ?", [before!.id])).toEqual(before);
      await execute("UPDATE secret_versions SET tag = ? WHERE id = ?", [Buffer.alloc(16), before!.id]);
      await expect(rewrapSecretVersion(before!.id, "new")).rejects.toMatchObject({ code: "SYS-9002" });
      expect((await one<{ key_version: string }>("SELECT key_version FROM secret_versions WHERE id = ?", [before!.id]))!.key_version).toBe("legacy");
    } finally { resetKeyFile(); }
  });
});
