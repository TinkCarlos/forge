import { writeFileSync } from "node:fs";
import { IDENTITY_OPENAPI } from "../packages/contracts/src/identity-openapi.js";
writeFileSync(new URL("../docs/03-api/identity.openapi.json", import.meta.url), `${JSON.stringify(IDENTITY_OPENAPI, null, 2)}\n`);
