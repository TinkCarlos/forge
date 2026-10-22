import { describe, expect, it } from "vitest";
import {
  defaultDataScope,
  decryptSecret,
  encryptSecret,
  hasPermission,
  hashApiKey,
  hashPassword,
  verifyPassword,
} from "@forge/core";
import { parseOpenApi } from "@forge/capabilities";

describe("security helpers", () => {
  it("hashes and verifies passwords", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(verifyPassword("wrong", hash)).toBe(false);
  });

  it("encrypts and decrypts provider secrets", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    const payload = encryptSecret("sk-test", key);
    expect(payload).not.toContain("sk-test");
    expect(decryptSecret(payload, key)).toBe("sk-test");
  });

  it("hashes api keys deterministically", () => {
    expect(hashApiKey("fsk_demo", "pepper")).toBe(hashApiKey("fsk_demo", "pepper"));
    expect(hashApiKey("fsk_demo", "pepper")).not.toBe(hashApiKey("fsk_demo2", "pepper"));
  });
});

describe("functional permissions", () => {
  it("grants platform admin wildcard and denies user management", () => {
    expect(hasPermission("platform_admin", "user.manage")).toBe(true);
    expect(hasPermission("user", "user.manage")).toBe(false);
    expect(hasPermission("user", "agent.run")).toBe(true);
    expect(hasPermission("auditor", "agent.manage")).toBe(false);
  });

  it("assigns safe default data scopes", () => {
    expect(defaultDataScope("platform_admin")).toBe("all");
    expect(defaultDataScope("builder")).toBe("org");
    expect(defaultDataScope("user")).toBe("self");
  });
});

describe("openapi parser", () => {
  it("turns operations into tools", () => {
    const parsed = parseOpenApi({
      openapi: "3.0.0",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/hello/{id}": {
          get: {
            operationId: "get_hello",
            summary: "Get hello",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          },
          post: {
            operationId: "post_hello",
            requestBody: {
              content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
            },
          },
        },
      },
    });
    expect(parsed.baseUrl).toBe("https://api.example.com");
    expect(parsed.tools).toHaveLength(2);
    expect(parsed.tools.find((tool) => tool.name === "get_hello")?.risk).toBe("low");
    expect(parsed.tools.find((tool) => tool.name === "post_hello")?.risk).toBe("high");
  });
});
