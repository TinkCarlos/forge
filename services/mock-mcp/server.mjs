import http from "node:http";

const tools = [
  {
    name: "get_time",
    description: "Return current server time",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "risky_submit",
    description: "Submit a simulated external write action",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Mcp-Session-Id": "demo-session" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/mcp" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (message.method === "initialize") {
      return send(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "forge-demo-mcp", version: "0.1.0" },
        },
      });
    }
    if (message.method === "notifications/initialized") {
      res.writeHead(202, { "Content-Type": "application/json" });
      return res.end();
    }
    if (message.method === "tools/list") {
      return send(res, 200, { jsonrpc: "2.0", id: message.id, result: { tools } });
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const text = name === "get_time" ? new Date().toISOString() : `submitted: ${String(args.text ?? "")}`;
      return send(res, 200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], isError: false } });
    }
    return send(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
  if (req.url === "/api/openapi.json") {
    return send(res, 200, {
      openapi: "3.0.0",
      servers: [{ url: "http://127.0.0.1:8090/api" }],
      paths: {
        "/hello": { get: { operationId: "get_hello", summary: "Hello", parameters: [{ name: "name", in: "query", schema: { type: "string" } }] } },
        "/submit": { post: { operationId: "post_submit", summary: "Submit", requestBody: { content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } } } } },
      },
    });
  }
  if (req.url?.startsWith("/api/hello")) {
    return send(res, 200, { ok: true, data: { message: `hello ${new URL(req.url, "http://localhost").searchParams.get("name") ?? "world"}` } });
  }
  if (req.url === "/api/submit" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return send(res, 200, { ok: true, data: { accepted: true, body: raw } });
  }
  send(res, 404, { ok: false });
});

server.listen(8090, "127.0.0.1", () => {
  console.log("Forge demo MCP/OpenAPI server on http://127.0.0.1:8090");
});
