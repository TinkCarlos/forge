import Ajv from "ajv";
import { OUTPUT_REPAIR_PREFIX } from "@forge/core";

export function validateOutput(content: string, schema: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; errors: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return { ok: false, errors: `JSON parse error: ${error instanceof Error ? error.message : String(error)}` };
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(parsed)) return { ok: false, errors: ajv.errorsText(validate.errors) };
  return { ok: true, value: parsed };
}

export function repairMessage(errors: string): string {
  return `${OUTPUT_REPAIR_PREFIX}. Fix the assistant reply so it is valid JSON matching the schema. Errors: ${errors}`;
}

export function repairCount(contents: string[]): number {
  return contents.filter((content) => content.includes(OUTPUT_REPAIR_PREFIX)).length;
}
