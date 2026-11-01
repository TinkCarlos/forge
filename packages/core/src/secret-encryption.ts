import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ForgeError } from "./errors/forge-error.js";

export interface MasterKeyring { activeVersion: string; keys: ReadonlyMap<string, Buffer> }
export interface SecretContext { secretId: string; version: number; scopeType: string; scopeId: string; scopeResourceType: string }
export interface SecretEnvelope {
  ciphertext: Buffer; nonce: Buffer; tag: Buffer;
  encryptedDek: Buffer; dekNonce: Buffer; dekTag: Buffer; keyVersion: string;
}
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEYRING_MAX_BYTES = 65_536;
const unavailable = () => new ForgeError("SYS-9002");

function masterKey(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw unavailable();
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw unavailable();
  return key;
}

export function parseMasterKeyring(raw: unknown): MasterKeyring {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unavailable();
  const { activeVersion, keys } = raw as Record<string, unknown>;
  if (typeof activeVersion !== "string" || !KEY_VERSION.test(activeVersion) || !keys || typeof keys !== "object" || Array.isArray(keys)) throw unavailable();
  const entries = Object.entries(keys);
  if (!entries.length || entries.length > 64 || entries.some(([name]) => !KEY_VERSION.test(name))) throw unavailable();
  const decoded = new Map(entries.map(([name, value]) => [name, masterKey(value)]));
  if (!decoded.has(activeVersion)) throw unavailable();
  return { activeVersion, keys: decoded };
}

/** Re-read on every operation: atomic file replacement changes the active key without a stale fallback cache. */
export function loadMasterKeyring(config: { FORGE_MASTER_KEY: string; FORGE_MASTER_KEYRING_FILE?: string }): MasterKeyring {
  if (!config.FORGE_MASTER_KEYRING_FILE) return { activeVersion: "legacy", keys: new Map([["legacy", masterKey(config.FORGE_MASTER_KEY.trim())]]) };
  let fd: number | undefined;
  try {
    fd = openSync(config.FORGE_MASTER_KEYRING_FILE, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid()) || info.size > KEYRING_MAX_BYTES) throw unavailable();
    const bytes = Buffer.alloc(KEYRING_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, length);
      if (!n) break;
      length += n;
    }
    if (length > KEYRING_MAX_BYTES) throw unavailable();
    // JSON parser diagnostics may echo a key fragment; never attach them as a logged cause.
    return parseMasterKeyring(JSON.parse(bytes.subarray(0, length).toString("utf8")));
  } catch {
    throw unavailable();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function aad(context: SecretContext): Buffer {
  if (!context.secretId || !Number.isInteger(context.version) || context.version < 1 || context.version > 4_294_967_295) throw unavailable();
  return Buffer.from(JSON.stringify(["forge-secret-v2", context.secretId, context.version, context.scopeType, context.scopeId, context.scopeResourceType]));
}
function encrypt(key: Buffer, plain: Buffer, context: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(context);
  return { ciphertext: Buffer.concat([cipher.update(plain), cipher.final()]), nonce, tag: cipher.getAuthTag() };
}
function decrypt(key: Buffer, row: { ciphertext: Buffer; nonce: Buffer; tag: Buffer }, context: Buffer): Buffer {
  if (!Buffer.isBuffer(row.ciphertext) || !Buffer.isBuffer(row.nonce) || !Buffer.isBuffer(row.tag) || row.nonce.length !== 12 || row.tag.length !== 16) throw unavailable();
  const decipher = createDecipheriv("aes-256-gcm", key, row.nonce);
  decipher.setAAD(context);
  decipher.setAuthTag(row.tag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
}
function dekFor(row: SecretEnvelope, context: Buffer, ring: MasterKeyring): Buffer {
  const key = ring.keys.get(row.keyVersion);
  if (!key || row.encryptedDek.length !== 32) throw unavailable();
  const dek = decrypt(key, { ciphertext: row.encryptedDek, nonce: row.dekNonce, tag: row.dekTag }, context);
  if (dek.length !== 32) throw unavailable();
  return dek;
}

export function sealSecret(plain: string, context: SecretContext, ring: MasterKeyring): SecretEnvelope {
  const dek = randomBytes(32);
  try {
    const key = ring.keys.get(ring.activeVersion);
    if (!key) throw unavailable();
    const associated = aad(context);
    const data = encrypt(dek, Buffer.from(plain, "utf8"), associated);
    const wrapped = encrypt(key, dek, associated);
    return { ...data, encryptedDek: wrapped.ciphertext, dekNonce: wrapped.nonce, dekTag: wrapped.tag, keyVersion: ring.activeVersion };
  } catch { throw unavailable(); } finally { dek.fill(0); }
}
export function openSecret(row: SecretEnvelope, context: SecretContext, ring: MasterKeyring): string {
  let dek: Buffer | undefined;
  try {
    const associated = aad(context);
    dek = dekFor(row, associated, ring);
    return decrypt(dek, row, associated).toString("utf8");
  } catch { throw unavailable(); } finally { dek?.fill(0); }
}
export function rewrapSecret(row: SecretEnvelope, context: SecretContext, ring: MasterKeyring): SecretEnvelope {
  let dek: Buffer | undefined;
  try {
    const associated = aad(context);
    dek = dekFor(row, associated, ring);
    // Verify the stored data as well; a corrupt row must not be counted as successfully migrated.
    decrypt(dek, row, associated).fill(0);
    const key = ring.keys.get(ring.activeVersion);
    if (!key) throw unavailable();
    const wrapped = encrypt(key, dek, associated);
    return { ...row, encryptedDek: wrapped.ciphertext, dekNonce: wrapped.nonce, dekTag: wrapped.tag, keyVersion: ring.activeVersion };
  } catch { throw unavailable(); } finally { dek?.fill(0); }
}

export function decryptLegacySecret(payload: string, ring: MasterKeyring): string {
  try {
    const [version, nonce, ciphertext, tag, extra] = payload.split(".");
    const key = ring.keys.get("legacy");
    if (!key || version !== "v1" || !nonce || !ciphertext || !tag || extra !== undefined) throw unavailable();
    return decrypt(key, { nonce: Buffer.from(nonce, "base64"), ciphertext: Buffer.from(ciphertext, "base64"), tag: Buffer.from(tag, "base64") }, Buffer.alloc(0)).toString("utf8");
  } catch { throw unavailable(); }
}
