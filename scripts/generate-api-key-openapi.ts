import { writeFileSync } from "node:fs";
import { API_KEYS_OPENAPI } from "../packages/contracts/src/api-keys-openapi.js";
writeFileSync(new URL("../docs/03-api/api-keys.openapi.json", import.meta.url), `${JSON.stringify(API_KEYS_OPENAPI, null, 2)}\n`);
