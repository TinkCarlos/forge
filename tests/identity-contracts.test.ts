import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ROLES_OPENAPI, IDENTITY_OPENAPI, USER_DTO_SCHEMA } from "@forge/contracts";
it("keeps account/operation-log OpenAPI aligned with contracts and excludes password material", () => {
  expect(JSON.parse(readFileSync(new URL("../docs/03-api/identity.openapi.json", import.meta.url),"utf8"))).toEqual(IDENTITY_OPENAPI);
  expect(JSON.parse(readFileSync(new URL("../docs/03-api/roles.openapi.json",import.meta.url),"utf8"))).toEqual(ROLES_OPENAPI);
  expect(USER_DTO_SCHEMA.additionalProperties).toBe(false);
  expect(USER_DTO_SCHEMA.properties).not.toHaveProperty("password_hash");
  expect(USER_DTO_SCHEMA.properties).not.toHaveProperty("password");
});
