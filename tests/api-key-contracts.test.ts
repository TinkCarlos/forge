import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { API_KEYS_OPENAPI } from "../packages/contracts/src/api-keys-openapi.js";

it("keeps the published internal API Key OpenAPI artifact in sync with contracts", () => {
  const artifact = JSON.parse(readFileSync(new URL("../docs/03-api/api-keys.openapi.json", import.meta.url), "utf8"));
  expect(artifact).toEqual(API_KEYS_OPENAPI);
});

import { CONFIGURATION_OPENAPI } from "@forge/contracts";
import { SECRETS_OPENAPI } from "@forge/contracts";

it("keeps configuration write OpenAPI in sync with the shared route contracts", () => {
  const artifact = JSON.parse(readFileSync(new URL("../docs/03-api/configuration.openapi.json", import.meta.url), "utf8"));
  expect(artifact).toEqual(CONFIGURATION_OPENAPI);
});

it("keeps credential metadata and write-only value OpenAPI in sync", () => {
  const artifact = JSON.parse(readFileSync(new URL("../docs/03-api/secrets.openapi.json", import.meta.url), "utf8"));
  expect(artifact).toEqual(SECRETS_OPENAPI);
});
