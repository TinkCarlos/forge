import { resolveTools } from "@forge/capabilities";
async function main() {
  const spec = { model: { provider: "mock", model: "mock-1" }, toolsets: [{ builtin: ["current_time"] }, { mcp: "demo-mcp", allow: ["get_time", "risky_submit"] }, { openapi: "demo-http", allow: ["get_hello"] }] };
  const tools = await resolveTools(spec);
  console.log([...tools.keys()]);
  process.exit(0);
}
void main();
