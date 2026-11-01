import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadMasterKeyring, openSecret, parseMasterKeyring, rewrapSecret, sealSecret, type SecretContext } from "../packages/core/src/secret-encryption.js";

const old = randomBytes(32).toString("base64"), next = randomBytes(32).toString("base64");
const first = parseMasterKeyring({ activeVersion: "legacy", keys: { legacy: old } });
const second = parseMasterKeyring({ activeVersion: "k2", keys: { legacy: old, k2: next } });
const context: SecretContext = { secretId: "sec_test", version: 1, scopeType: "resource", scopeId: "resource1", scopeResourceType: "llm_provider" };
const dir = mkdtempSync(join(tmpdir(), "forge-keyring-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("SEC01 envelope encryption and key versions", () => {
  it("uses independent DEKs/nonces, authenticates context, and reads old and new key versions", () => {
    const a = sealSecret("synthetic credential", context, first), b = sealSecret("synthetic credential", context, first);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.encryptedDek.equals(b.encryptedDek)).toBe(false);
    expect(openSecret(a, context, second)).toBe("synthetic credential");
    expect(openSecret(sealSecret("new", context, second), context, second)).toBe("new");
    for (const changed of [{ secretId: "other" }, { version: 2 }, { scopeId: "other" }, { scopeType: "org" }, { scopeResourceType: "mcp_server" }]) expect(() => openSecret(a, { ...context, ...changed }, second)).toThrow(expect.objectContaining({ code: "SYS-9002" }));
  });
  it.each(["ciphertext", "nonce", "tag", "encryptedDek", "dekNonce", "dekTag"] as const)("refuses tampered %s without echoing material", field => {
    const a = sealSecret("do-not-echo-secret", context, first);
    const changed = { ...a, [field]: Buffer.from(a[field]) }; changed[field][0]! ^= 1;
    expect(() => openSecret(changed, context, second)).toThrow(expect.objectContaining({ code: "SYS-9002" }));
  });
  it("rewraps only the DEK, verifies the data and survives retiring the old key afterwards", () => {
    const a = sealSecret("value", context, first), b = rewrapSecret(a, context, second);
    expect(b.keyVersion).toBe("k2");
    expect(b.ciphertext).toEqual(a.ciphertext); expect(b.nonce).toEqual(a.nonce); expect(b.tag).toEqual(a.tag);
    const retired = parseMasterKeyring({ activeVersion: "k2", keys: { k2: next } });
    expect(openSecret(b, context, retired)).toBe("value");
    expect(() => openSecret(a, context, retired)).toThrow(expect.objectContaining({ code: "SYS-9002" }));
    expect(() => rewrapSecret({ ...a, tag: Buffer.alloc(16) }, context, second)).toThrow();
  });
});

describe("SEC02 private keyring reload and fail-closed configuration", () => {
  it("re-reads an atomically replaced keyring without restart and rejects damaged replacement", () => {
    const path = join(dir, "keys.json");
    writeFileSync(path, JSON.stringify({ activeVersion: "legacy", keys: { legacy: old } }), { mode: 0o600 });
    const config = { FORGE_MASTER_KEY: old, FORGE_MASTER_KEYRING_FILE: path };
    expect(loadMasterKeyring(config).activeVersion).toBe("legacy");
    const fresh = join(dir, "keys.new"); writeFileSync(fresh, JSON.stringify({ activeVersion: "k2", keys: { legacy: old, k2: next } }), { mode: 0o600 }); renameSync(fresh, path);
    expect(loadMasterKeyring(config).activeVersion).toBe("k2");
    writeFileSync(path, `{"secret": "${next}", broken`);
    try { loadMasterKeyring(config); throw Error("should refuse"); } catch (err) { expect(String(err)).not.toContain(next); expect(err).toMatchObject({ code: "SYS-9002" }); }
  });
  it("refuses public/symlink/oversized/missing files", () => {
    const path = join(dir, "unsafe.json"), config = { FORGE_MASTER_KEY: old, FORGE_MASTER_KEYRING_FILE: path };
    writeFileSync(path, JSON.stringify({ activeVersion: "k2", keys: { k2: next } }), { mode: 0o644 });
    expect(() => loadMasterKeyring(config)).toThrow(); chmodSync(path, 0o600);
    const link = join(dir, "link.json"); symlinkSync(path, link); expect(() => loadMasterKeyring({ ...config, FORGE_MASTER_KEYRING_FILE: link })).toThrow();
    writeFileSync(path, "x".repeat(65537)); expect(() => loadMasterKeyring(config)).toThrow();
    expect(() => loadMasterKeyring({ ...config, FORGE_MASTER_KEYRING_FILE: join(dir, "missing") })).toThrow();
  });
  it.each([{}, [], { activeVersion: "missing", keys: { k2: next } }, { activeVersion: "k2", keys: { k2: "invalid" } }, { activeVersion: "k 2", keys: { "k 2": next } }])("rejects malformed keyring %j", raw => expect(() => parseMasterKeyring(raw)).toThrow());
});
