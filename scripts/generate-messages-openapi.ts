import {writeFileSync} from "node:fs";
import {MESSAGES_OPENAPI} from "../packages/contracts/src/messages-openapi.js";
writeFileSync(new URL("../docs/03-api/messages.openapi.json",import.meta.url),JSON.stringify(MESSAGES_OPENAPI,null,2)+"\n");
