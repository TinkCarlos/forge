import {writeFileSync} from "node:fs";
import {JOBS_OPENAPI} from "../packages/contracts/src/jobs-openapi.js";
writeFileSync(new URL("../docs/03-api/jobs.openapi.json",import.meta.url),JSON.stringify(JOBS_OPENAPI,null,2)+"\n");
