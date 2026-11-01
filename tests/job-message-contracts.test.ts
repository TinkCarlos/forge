import { describe, expect, it } from "vitest";
import { JOB_LIMITS_SCHEMA, JOB_INVOKE_SCHEMA, JOB_CONTROL_SCHEMA, MESSAGE_RETRY_SCHEMA, MESSAGE_TEMPLATE_SCHEMA, JOB_NAME_SCHEMA } from "../packages/contracts/src/job-messaging.js";

describe("Job/message shared input contracts (technical vectors)", () => {
  it("counts names as Unicode code points and normalizes surrounding space", () => {
    expect(JOB_NAME_SCHEMA.parse(` ${"😀".repeat(128)} `)).toBe("😀".repeat(128));
    expect(JOB_NAME_SCHEMA.safeParse("😀".repeat(129)).success).toBe(false);
    expect(JOB_NAME_SCHEMA.safeParse(" \n ").success).toBe(false);
  });
  it("sets the approved limits without coercing numeric strings", () => {
    expect(JOB_LIMITS_SCHEMA.parse({})).toEqual({ maxConcurrentExecutions: 1, maxParallelItems: 2, stepTimeoutSeconds: 300, activeTimeoutSeconds: 3600, waitTimeoutSeconds: 604800, maxAttempts: 2, maxCostUsd: "1.000000" });
    for (const invalid of [{ maxAttempts: 0 }, { maxParallelItems: 17 }, { stepTimeoutSeconds: "300" }, { maxConcurrentExecutions: null }, { maxCostUsd: "0.000000" }, { maxCostUsd: "10000.000001" }, { maxCostUsd: 1 }, { maxCostUsd: "1.00" }, { waitTimeoutSeconds: 7776001 }]) {
      expect(JOB_LIMITS_SCHEMA.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
    expect(JOB_LIMITS_SCHEMA.safeParse({ maxCostUsd: "0.000001", maxAttempts: 5, waitTimeoutSeconds: 7776000 }).success).toBe(true);
  });
  const invoke = { input: {}, businessRef: { type: "technical", id: "example" } };
  it("accepts one thousand distinct technical items, rejects empty or duplicate batches", () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ key: String(i), input: {} }));
    expect(JOB_INVOKE_SCHEMA.safeParse({ ...invoke, items }).success).toBe(true);
    for (const bad of [[], [...items, { key: "1000", input: {} }], [{ key: "same", input: {} }, { key: "same", input: {} }]]) {
      expect(JOB_INVOKE_SCHEMA.safeParse({ ...invoke, items: bad }).success).toBe(false);
    }
  });
  it("rejects non-JSON values, oversized items and self-reported principals", () => {
    for (const input of [{ n: Infinity }, { n: undefined }, { d: new Date() }]) expect(JOB_INVOKE_SCHEMA.safeParse({ ...invoke, input }).success).toBe(false);
    expect(JOB_INVOKE_SCHEMA.safeParse({ ...invoke, actorId: "forged" }).success).toBe(false);
    expect(JOB_INVOKE_SCHEMA.safeParse({ ...invoke, items: [{ key: "one", input: { s: "中".repeat(22000) } }] }).success).toBe(false);
  });
  it("enforces control-field dependencies without granting reconciliation by resume", () => {
    expect(JOB_CONTROL_SCHEMA.safeParse({ action: "retry_failed", reason: "恢复失败项" }).success).toBe(true);
    for (const bad of [{ action: "resume", reason: "x", stepIds: [] }, { action: "retry_failed", reason: "x", stepIds: [] }, { action: "force_success", reason: "x" }, { action: "cancel", reason: "  " }]) expect(JOB_CONTROL_SCHEMA.safeParse(bad).success).toBe(false);
  });
  it("accepts explicit re-send intent while rejecting target/body overrides", () => {
    expect(MESSAGE_RETRY_SCHEMA.safeParse({ reason: "核实后重发", acknowledgeDuplicate: true, acknowledgeHistoricalTarget: true }).success).toBe(true);
    for (const bad of [{ reason: " " }, { reason: "x", endpoint: "https://example.invalid" }, { reason: "x", payload: {} }, { reason: "x", acknowledgeDuplicate: "true" }]) expect(MESSAGE_RETRY_SCHEMA.safeParse(bad).success).toBe(false);
  });
  it("limits template bytes and variables independently of UTF-16 length", () => {
    const template = { key: "test-template", name: "测试", content: "中".repeat(682) + "ab", variables: [] };
    expect(MESSAGE_TEMPLATE_SCHEMA.safeParse(template).success).toBe(true);
    expect(MESSAGE_TEMPLATE_SCHEMA.safeParse({ ...template, content: "中".repeat(683) }).success).toBe(false);
    expect(MESSAGE_TEMPLATE_SCHEMA.safeParse({ ...template, content: "{{secret}}", variables: ["secret"] }).success).toBe(false);
    expect(MESSAGE_TEMPLATE_SCHEMA.safeParse({ ...template, content: "{{status}}", variables: [] }).success).toBe(false);
    expect(MESSAGE_TEMPLATE_SCHEMA.safeParse({ ...template, content: "{{status}}", variables: ["status"] }).success).toBe(true);
  });
});

it("accepts exact 64 KiB item and 1 MiB input boundaries independently, rejects one extra byte", () => {
  const invoke = { input: {}, businessRef: { type: "technical", id: "one" } };
  const emptyItem = { key: "one", input: { text: "" } };
  const overhead = Buffer.byteLength(JSON.stringify(emptyItem), "utf8");
  const item = { ...emptyItem, input: { text: "x".repeat(65536 - overhead) } };
  expect(Buffer.byteLength(JSON.stringify(item), "utf8")).toBe(65536);
  expect(JOB_INVOKE_SCHEMA.safeParse({ ...invoke, items: [item] }).success).toBe(true);
  expect(JOB_INVOKE_SCHEMA.safeParse({ ...invoke, items: [{ ...item, input: { text: item.input.text + "x" } }] }).success).toBe(false);
  const empty = { ...invoke, input: { text: "" } }, totalOverhead = Buffer.byteLength(JSON.stringify(empty), "utf8");
  const boundary = { ...empty, input: { text: "x".repeat(1048576 - totalOverhead) } };
  expect(Buffer.byteLength(JSON.stringify(boundary), "utf8")).toBe(1048576);
  expect(JOB_INVOKE_SCHEMA.safeParse(boundary).success).toBe(true);
  expect(JOB_INVOKE_SCHEMA.safeParse({ ...boundary, input: { text: boundary.input.text + "x" } }).success).toBe(false);
});
it.each([
  ["maxConcurrentExecutions", 1, 20], ["maxParallelItems", 1, 16], ["stepTimeoutSeconds", 1, 86400],
  ["activeTimeoutSeconds", 1, 604800], ["waitTimeoutSeconds", 60, 7776000], ["maxAttempts", 1, 5],
] as const)("checks both inclusive numeric limits for %s without coercion", (field, minimum, maximum) => {
  for (const value of [minimum, minimum + 1, maximum - 1, maximum]) expect(JOB_LIMITS_SCHEMA.safeParse({ [field]: value }).success).toBe(true);
  for (const value of [minimum - 1, maximum + 1, 1.5, String(minimum), null]) expect(JOB_LIMITS_SCHEMA.safeParse({ [field]: value }).success).toBe(false);
});
