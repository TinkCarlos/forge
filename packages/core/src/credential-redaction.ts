import { ForgeError } from "./errors/forge-error.js";

/** Per invocation, never a process-wide registry mixing secrets from unrelated runs. */
export function credentialRedactor(values: readonly string[]) {
  const literals = [...new Set(values.filter(Boolean).flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  const matchAt = (value: string, from = 0) => {
    let start = -1, length = 0;
    for (const literal of literals) {
      const i = value.indexOf(literal, from);
      if (i !== -1 && (start === -1 || i < start)) { start = i; length = literal.length; }
    }
    return start === -1 ? null : { start, length };
  };
  const maxLength = Math.max(0, ...literals.map(value => value.length));
  const text = (value: string): string => {
    if (!literals.length) return value;
    let from = 0; const parts: string[] = [];
    for (let match = matchAt(value); match; match = matchAt(value, from)) {
      parts.push(value.slice(from, match.start), "***"); from = match.start + match.length;
    }
    return parts.join("") + value.slice(from);
  };
  const identifier = (value: string): string => {
    if (text(value) !== value) throw new ForgeError("SYS-9002", { message: "凭据值与工具或JSON字段名冲突" });
    return value;
  };
  const walk = (input: unknown, depth: number, maskKeys = true): unknown => {
    if (typeof input === "string") return text(input);
    if (!input || typeof input !== "object" || !literals.length) return input;
    if (depth >= 30) return "[truncated]";
    if (input instanceof Error) return { name: input.name, message: text(input.message) };
    if (Array.isArray(input)) return input.map(v => walk(v, depth + 1, maskKeys));
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [maskKeys ? text(key) : identifier(key), walk(value, depth + 1, maskKeys)]));
  };
  const jsonText = (input: string): string => {
    if (!literals.length) return input;
    if (/^\s*[\[{]/.test(input)) {
      try { JSON.parse(input); }
      catch { return text(input); }
      // Edit string tokens only: serializing parsed JSON would round int64 IDs and other numeric literals.
      return input.replace(/"(?:[^"\\]|\\.)*"/g, (token: string, offset: number) => {
        const value = JSON.parse(token) as string;
        return /^\s*:/.test(input.slice(offset + token.length)) ? (identifier(value), token) : JSON.stringify(text(value));
      });
    }
    return text(input);
  };
  const instance = (input: unknown, depth = 0): unknown => {
    if (typeof input === "string") return identifier(input);
    if (!input || typeof input !== "object" || !literals.length) return input;
    if (depth >= 30) throw new ForgeError("SYS-9002");
    if (Array.isArray(input)) return input.map(value => instance(value, depth + 1));
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [identifier(key), instance(value, depth + 1)]));
  };
  const schema = (input: unknown, depth = 0): unknown => {
    if (typeof input === "string") return identifier(input);
    if (!input || typeof input !== "object" || !literals.length) return input;
    if (depth >= 30) throw new ForgeError("SYS-9002");
    if (Array.isArray(input)) return input.map(value => schema(value, depth + 1));
    return Object.fromEntries(Object.entries(input).map(([key, value]) => {
      if (["title", "description", "$comment"].includes(key)) return [key, walk(value, 0)];
      if (key === "type") {
        const types = Array.isArray(value) ? value : [value];
        if (types.some(type => !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(type)))) throw new ForgeError("SYS-9002");
        return [key, value];
      }
      if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key) && value && typeof value === "object" && !Array.isArray(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [identifier(name), schema(child, depth + 1)]))];
      if (key === "dependencies" && value && typeof value === "object" && !Array.isArray(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [identifier(name), Array.isArray(child) ? instance(child, depth + 1) : schema(child, depth + 1)]))];
      if (["additionalProperties", "unevaluatedProperties", "propertyNames", "items", "additionalItems", "contains", "unevaluatedItems", "not", "if", "then", "else", "contentSchema", "prefixItems", "allOf", "anyOf", "oneOf"].includes(key)) return [key, schema(value, depth + 1)];
      if (key === "required" && Array.isArray(value)) return [key, value.map(name => typeof name === "string" ? identifier(name) : name)];
      if (["$ref", "$id", "$anchor", "$dynamicRef", "$dynamicAnchor"].includes(key) && typeof value === "string") return [key, identifier(value)];
      const protocol = ["$schema", "$defs", "$vocabulary", "properties", "patternProperties", "additionalProperties", "unevaluatedProperties", "propertyNames", "required", "dependentSchemas", "dependentRequired", "dependencies", "definitions", "items", "prefixItems", "additionalItems", "contains", "unevaluatedItems", "minContains", "maxContains", "uniqueItems", "minItems", "maxItems", "minProperties", "maxProperties", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "enum", "const", "contentEncoding", "contentMediaType", "contentSchema", "readOnly", "writeOnly", "deprecated", "nullable", "discriminator", "xml", "externalDocs"];
      return [protocol.includes(key) || ["examples", "example", "default"].includes(key) ? key : identifier(key), instance(value, depth + 1)];
    }));
  };
  let tail = "", streamMode: "pending" | "text" | "json" = "pending";
  return {
    text,
    identifier,
    jsonText,
    value: <T>(input: T): T => walk(input, 0) as T,
    // Preserve protocol keywords, property names and type/format/required values in model tool schemas.
    schema: <T>(input: T): T => schema(input) as T,
    error: (error: ForgeError): ForgeError => literals.length ? new ForgeError(error.code, { message: text(error.message), details: walk(error.details, 0), httpStatus: error.httpStatus, retryable: error.retryable, headers: walk(error.headers, 0) as Readonly<Record<string, string>> | undefined }, walk(error.cause, 0)) : error,
    chunk(value: string): string {
      if (!literals.length) return value;
      tail += value;
      if (streamMode === "pending") {
        const first = tail.trimStart()[0];
        if (!first) return "";
        streamMode = first === "{" || first === "[" ? "json" : "text";
      }
      // An object/array must be complete before distinguishing JSON keys/numbers from string content.
      if (streamMode === "json") return "";
      let end = Math.max(0, tail.length - maxLength + 1);
      for (let match = matchAt(tail); match; match = matchAt(tail, match.start + match.length)) {
        if (match.start < end && match.start + match.length > end) { end = match.start; break; }
      }
      const safe = text(tail.slice(0, end)); tail = tail.slice(end);
      return safe;
    },
    flush(): string { const safe = streamMode === "json" ? jsonText(tail) : text(tail); tail = ""; streamMode = "pending"; return safe; },
  };
}
