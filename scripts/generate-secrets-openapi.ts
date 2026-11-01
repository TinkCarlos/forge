import { writeFileSync } from "node:fs";
import { SECRETS_OPENAPI } from "../packages/contracts/src/secrets-openapi.js";
writeFileSync(new URL("../docs/03-api/secrets.openapi.json", import.meta.url), `${JSON.stringify(SECRETS_OPENAPI, null, 2)}\n`);
