import { writeFileSync } from "node:fs";
import { CONFIGURATION_OPENAPI } from "../packages/contracts/src/configuration.js";
writeFileSync(new URL("../docs/03-api/configuration.openapi.json", import.meta.url), `${JSON.stringify(CONFIGURATION_OPENAPI, null, 2)}\n`);
