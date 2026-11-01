import { describe, expect, it } from "vitest";
import { JOB_CREATE_SCHEMA, JOB_MANIFEST_SCHEMA, JOB_MAPPING_SCHEMA, MESSAGE_CHANNEL_CREATE_SCHEMA, MESSAGE_CHANNEL_PATCH_SCHEMA, MESSAGE_RULE_CREATE_SCHEMA, JOB_IDEMPOTENCY_KEY_SCHEMA } from "@forge/contracts";
import { evaluateJobCondition, resolveJobMapping, type JobExpressionContext } from "../packages/runtime/src/job-expressions.js";
import { JOB_MESSAGE_PERMISSIONS, PERMISSION_CATALOG, ROLE_PERMISSIONS, newId } from "@forge/core";
const target = { kind: "agent", key: "test-agent", version: "1", checksum: "a".repeat(64) };
const manifest = { schemaVersion: 1, target, inputSchema: {}, outputSchema: {}, nodes: [] };
const id = "01K8Y000000000000000000001";
const context: JobExpressionContext = { input: { zero: 0, nil: null, no: false, object: { b: 2, a: 1 }, array: ["one"], "a/b": "escaped" }, businessRef: {}, item: {}, steps: {} };

describe("Job definitions, expressions and message boundary contracts", () => {
  it("uses full ULIDs and registers permissions without granting them to existing role templates", () => {
    expect(newId()).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    for (const code of JOB_MESSAGE_PERMISSIONS) {
      expect(PERMISSION_CATALOG.some(entry => entry.key === code)).toBe(true);
      for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) if (role !== "platform_admin") expect(permissions).not.toContain(code);
    }
  });
  it("normalizes the approved manifest defaults and rejects absent targets or remote schema references", () => {
    expect(JOB_CREATE_SCHEMA.parse({ key: "test-job", name: "任务", businessType: "test", draft: manifest }).status).toBe("disabled");
    expect(JOB_MANIFEST_SCHEMA.parse(manifest).limits.maxAttempts).toBe(2);
    for (const bad of [{ ...manifest, target: undefined }, { ...manifest, inputSchema: { $ref: "https://example.invalid/schema" } }, { ...manifest, target: { ...target, kind: "flow" } }]) expect(JOB_MANIFEST_SCHEMA.safeParse(bad).success).toBe(false);
  });
  it("rejects duplicate or dangling flow nodes and validates an output node", () => {
    const node = { key: "one", kind: "agent", target, dependsOn: [], inputMapping: { ref: "/input" }, outputSchema: {} };
    const flow = { ...manifest, target: { ...target, kind: "flow" }, outcomeNodeKey: "one", nodes: [node] };
    expect(JOB_MANIFEST_SCHEMA.safeParse(flow).success).toBe(true);
    expect(JOB_MANIFEST_SCHEMA.safeParse({ ...flow, nodes: [node, node] }).success).toBe(false);
    expect(JOB_MANIFEST_SCHEMA.safeParse({ ...flow, nodes: [{ ...node, dependsOn: ["missing"] }] }).success).toBe(false);
  });
  it("distinguishes missing from null, zero and false, supports escaped own properties", () => {
    for (const key of ["nil", "zero", "no"]) expect(evaluateJobCondition({ op: "exists", ref: `/input/${key}` }, context)).toBe(true);
    expect(evaluateJobCondition({ op: "exists", ref: "/input/missing" }, context)).toBe(false);
    expect(evaluateJobCondition({ op: "ne", left: { ref: "/input/missing" }, right: { literal: null } }, context)).toBe(false);
    expect(resolveJobMapping({ ref: "/input/a~1b" }, context)).toBe("escaped");
    expect(() => resolveJobMapping({ ref: "/input/missing" }, context)).toThrow(expect.objectContaining({ code: "QAL-7301" }));
    expect(resolveJobMapping({ object: { value: { ref: "/input/zero" }, arr: { array: [{ literal: null }] } } }, context)).toEqual({ value: 0, arr: [null] });
  });
  it("compares strict canonical JSON and rejects invalid comparison operands", () => {
    expect(evaluateJobCondition({ op: "eq", left: { ref: "/input/object" }, right: { literal: { a: 1, b: 2 } } }, context)).toBe(true);
    expect(evaluateJobCondition({ op: "eq", left: { literal: 1 }, right: { literal: "1" } }, context)).toBe(false);
    expect(evaluateJobCondition({ op: "in", left: { literal: 1 }, right: { literal: ["1", 1] } }, context)).toBe(true);
    for (const op of ["in", "gt"]) expect(() => evaluateJobCondition({ op, left: { literal: 1 }, right: { literal: "1" } }, context)).toThrow(expect.objectContaining({ code: "QAL-7301" }));
  });
  it("rejects prototype access, wildcards, multiple mapping modes and depth overflow", () => {
    for (const ref of ["/input/__proto__", "/input/constructor", "/input/prototype", "/input/*", "/input/~2", "input/zero"]) expect(() => resolveJobMapping({ ref }, context)).toThrow();
    expect(evaluateJobCondition({ op: "exists", ref: "/input/array/length" }, context)).toBe(false);
    expect(JOB_MAPPING_SCHEMA.safeParse({ ref: "/input", literal: 1 }).success).toBe(false);
    let nested: unknown = { literal: 1 };
    for (let i = 0; i < 8; i++) nested = { array: [nested] };
    expect(JOB_MAPPING_SCHEMA.safeParse(nested).success).toBe(false);
  });
  it("enforces channel discriminants and prevents forged credential owners", () => {
    const webhook = { key: "callback", name: "回调", type: "webhook", endpoint: { value: "https://example.invalid" }, signingSecret: { secretId: id } };
    expect(MESSAGE_CHANNEL_CREATE_SCHEMA.safeParse(webhook).success).toBe(true);
    for (const bad of [{ ...webhook, signingSecret: undefined }, { ...webhook, credentialOwner: "api_app" }, { ...webhook, type: "wecom" }, { ...webhook, endpoint: { value: "x", secretId: id } }, { ...webhook, headerSecretRefs: { "X-Forge-Signature": id } }]) expect(MESSAGE_CHANNEL_CREATE_SCHEMA.safeParse(bad).success).toBe(false);
    expect(MESSAGE_CHANNEL_PATCH_SCHEMA.safeParse({ endpoint: { value: "[REDACTED]" } }).success).toBe(false);
    for (const value of [" ", "not-a-url", "file:///tmp/a", "https://user:secret@example.invalid", "https://example.invalid/#fragment"]) expect(MESSAGE_CHANNEL_PATCH_SCHEMA.safeParse({ endpoint: { value } }).success).toBe(false);
  });
  it("validates explicit recipients, scopes, event subscriptions and idempotency headers", () => {
    const channel = { key: "team-chat", name: "通知", type: "wecom", endpoint: { secretId: id } };
    expect(MESSAGE_CHANNEL_CREATE_SCHEMA.safeParse({ ...channel, mentionedIds: ["user.one"], mentionedMobiles: ["13800138000"] }).success).toBe(true);
    for (const extra of [{ mentionedIds: ["@all"] }, { mentionedIds: ["one", "one"] }, { mentionedMobiles: ["wrong"] }]) expect(MESSAGE_CHANNEL_CREATE_SCHEMA.safeParse({ ...channel, ...extra }).success).toBe(false);
    const rule = { key: "completed", name: "完成", eventType: "job.completed", scope: { type: "job", id }, channelId: id, status: "disabled" };
    expect(MESSAGE_RULE_CREATE_SCHEMA.safeParse(rule).success).toBe(true);
    expect(MESSAGE_RULE_CREATE_SCHEMA.safeParse({ ...rule, scope: { type: "global", id } }).success).toBe(false);
    for (const key of ["", "a b", "a\nb", "é", "x".repeat(201)]) expect(JOB_IDEMPOTENCY_KEY_SCHEMA.safeParse(key).success).toBe(false);
  });
});

it("PATCH preserves omitted defaults and validates UTF-8 secret limits", async () => {
  const { JOB_PATCH_SCHEMA, MESSAGE_RULE_PATCH_SCHEMA, MESSAGE_SECRET_INPUT_SCHEMA } = await import("@forge/contracts");
  expect(JOB_PATCH_SCHEMA.parse({ name: "改名" })).toEqual({ name: "改名" });
  expect(MESSAGE_RULE_PATCH_SCHEMA.parse({ name: "改名" })).toEqual({ name: "改名" });
  expect(MESSAGE_SECRET_INPUT_SCHEMA.safeParse({ value: "中".repeat(21845) + "x" }).success).toBe(true);
  expect(MESSAGE_SECRET_INPUT_SCHEMA.safeParse({ value: "中".repeat(21846) }).success).toBe(false);
});
it("deep JSON values and cyclic JavaScript objects cannot overflow recursive parsing", async () => {
  const { canonicalJobJson, JOB_INVOKE_SCHEMA } = await import("@forge/contracts");
  let value: import("@forge/contracts").JobJson = 1;
  for (let i = 0; i < 5000; i++) value = [value];
  expect(JOB_MAPPING_SCHEMA.safeParse({ literal: value }).success).toBe(true);
  expect(canonicalJobJson(value)).toHaveLength(10001);
  expect(JOB_INVOKE_SCHEMA.safeParse({ input: { value }, businessRef: { type: "test", id: "one" } }).success).toBe(true);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(JOB_MAPPING_SCHEMA.safeParse({ literal: cyclic }).success).toBe(false);
});
it("publication rejects implicit cycles, cyclic output and undeclared step references", () => {
  const one = { key: "one", kind: "domain", target, dependsOn: ["two"], inputMapping: { literal: {} }, outputSchema: {} };
  const two = { ...one, key: "two", dependsOn: ["one"] };
  const output = { ...one, key: "output", dependsOn: ["two"] };
  const flow = { ...manifest, target: { ...target, kind: "flow" }, nodes: [one, two, output], outcomeNodeKey: "output" };
  expect(JOB_MANIFEST_SCHEMA.safeParse(flow).success).toBe(false);
  const bounded = { ...flow, nodes: [{ ...one, maxIterations: 3 }, { ...two, maxIterations: 3 }, output] };
  expect(JOB_MANIFEST_SCHEMA.safeParse(bounded).success).toBe(true);
  expect(JOB_MANIFEST_SCHEMA.safeParse({ ...bounded, outcomeNodeKey: "one" }).success).toBe(false);
  expect(JOB_MANIFEST_SCHEMA.safeParse({ ...bounded, nodes: [...bounded.nodes.slice(0, 2), { ...output, dependsOn: [], inputMapping: { ref: "/steps/two/output" } }] }).success).toBe(false);
});
