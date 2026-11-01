/**
 * K-33: entity id rules, shared with the consoles (they validate API path segments with ID_PATTERN_SOURCE).
 *
 * Every generated id is `${prefix}_${suffix}`: a 3-letter lowercase prefix, "_", then the first 22 chars of a ULID
 * (10 time chars + 12 of the 16 random chars, ~60 random bits; uppercase Crockford base32) - 26 chars in total,
 * matching `id CHAR(26)`. Seed rows and new Job/message entities use complete 26-character ULIDs through newId().
 */
export const ID_PREFIX_LENGTH = 3;
export const ID_LENGTH = 26;

/** Exact source of the id regex (anchored); the frontend copies must equal this string. */
export const ID_PATTERN_SOURCE = "^(?:[0-9A-HJKMNP-TV-Z]{26}|[a-z]{3}_[0-9A-HJKMNP-TV-Z]{22})$";
export const ID_PATTERN = new RegExp(ID_PATTERN_SOURCE);

/** Every prefix passed to ulidWithPrefix in the code (pinned against the call sites by tests/id-pattern.test.ts). */
export const ID_PREFIXES = [
  "agt", "app", "apr", "aud", "dlv", "idm", "key", "mcp", "mct", "mdl", "msg", "orm", "pkg", "prv",
  "rbd", "ref", "rol", "rte", "run", "sch", "scv", "sec", "skl", "skv", "stp", "svc", "tcl", "thr", "tls", "tol", "usr", "ver",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/**
 * Route path params by kind: `:id` always carries a generated / seed id (looked up WHERE id = ?), `:key` (only
 * /open/v1/agents/:key, /runs, /invoke) carries the agent's key slug - never validate it with ID_PATTERN.
 */
export const PATH_PARAM_KINDS: Readonly<Record<string, "id" | "slug">> = Object.freeze({ id: "id", key: "slug" });
