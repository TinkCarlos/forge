import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { expect, it } from "vitest";
import { config, encryptSecret, ulidWithPrefix } from "@forge/core";

it("runs migration/rewrap CLIs against an empty real MySQL database, with safe failure and repeat output", {timeout:60_000}, async () => {
  const url = new URL(config.DATABASE_URL), database = `forge_secret_ops_${Date.now()}_test`;
  const conn = await mysql.createConnection({host:url.hostname,port:Number(url.port || 3306),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password)});
  const dir = mkdtempSync(join(tmpdir(),"forge-secret-cli-")), keyFile=join(dir,"keys.json"), nextKey=randomBytes(32).toString("base64");
  const canary = "synthetic-cli-private-value", badValue="synthetic-invalid-ciphertext-do-not-print";
  writeFileSync(keyFile,JSON.stringify({activeVersion:"legacy",keys:{legacy:config.FORGE_MASTER_KEY.trim()}}),{mode:0o600});
  url.pathname=`/${database}`;
  const env = {...process.env,DATABASE_URL:url.href,TEST_DATABASE_URL:url.href,FORGE_MASTER_KEYRING_FILE:keyFile};
  const run = (script:string,...args:string[]) => execFileSync(process.execPath,["--import","tsx",script,...args],{cwd:new URL("..",import.meta.url),env,encoding:"utf8"});
  try {
    await conn.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    expect(run("scripts/migrate.ts")).toContain("010_secret_vault applied");
    expect(run("scripts/migrate.ts")).toContain("010_secret_vault already applied");
    await conn.query(`USE \`${database}\``);
    const id=ulidWithPrefix("prv");
    await conn.execute("INSERT INTO llm_providers (id,`key`,name,protocol,base_url,headers_json,api_key_encrypted) VALUES (?,'legacy-cli','Legacy','openai-compatible','https://llm.example',?,?)",[id,JSON.stringify({"X-Token":canary}),encryptSecret(canary,config.FORGE_MASTER_KEY)]);
    const first=run("scripts/secrets-maintenance.ts","migrate");
    expect(first).not.toContain(canary); expect(JSON.parse(first.trim())).toMatchObject({scanned:1,changed:1,failed:0});
    expect(JSON.parse(run("scripts/secrets-maintenance.ts","migrate").trim())).toMatchObject({changed:0,failed:0});
    await conn.execute("UPDATE llm_providers SET api_key_encrypted = ? WHERE id = ?",[badValue,id]);
    const bad=spawnSync(process.execPath,["--import","tsx","scripts/secrets-maintenance.ts","migrate"],{cwd:new URL("..",import.meta.url),env,encoding:"utf8"});
    expect(bad.status).toBe(1); expect(bad.stdout+bad.stderr).not.toContain(badValue); expect(bad.stdout+bad.stderr).not.toContain(canary);
    const [kept]=await conn.query<RowDataPacket[]>("SELECT api_key_encrypted FROM llm_providers WHERE id = ?",[id]); expect(kept[0]!.api_key_encrypted).toBe(badValue);
    await conn.execute("UPDATE llm_providers SET api_key_encrypted = NULL WHERE id = ?",[id]);
    writeFileSync(keyFile,JSON.stringify({activeVersion:"next",keys:{legacy:config.FORGE_MASTER_KEY.trim(),next:nextKey}}));
    const wrapped=JSON.parse(run("scripts/secrets-maintenance.ts","rewrap").trim());
    expect(wrapped).toMatchObject({scanned:2,changed:2,failed:0,legacyCiphertexts:0,keyVersions:[{keyVersion:"next",count:2}]});
    writeFileSync(keyFile,JSON.stringify({activeVersion:"next",keys:{next:nextKey}}));
    expect(JSON.parse(run("scripts/secrets-maintenance.ts","rewrap").trim())).toMatchObject({changed:0,failed:0,keyVersions:[{keyVersion:"next",count:2}]});
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${database}\``); await conn.end(); rmSync(dir,{recursive:true,force:true});
  }
});
