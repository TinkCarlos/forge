import { writeFileSync } from "node:fs";
import { ROLES_OPENAPI } from "../packages/contracts/src/roles-openapi.js";
writeFileSync(new URL("../docs/03-api/roles.openapi.json", import.meta.url), `${JSON.stringify(ROLES_OPENAPI, null, 2)}\n`);
