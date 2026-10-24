// P1 SSE: masking a streamed model message (message.delta) to the same degree as REST. Pure: no I/O.
// The accumulated text of the message is masked as a whole with maskArgsDeep (the run-output mask, no second rule set)
// and only a stable prefix is released. The tail is held while it could still be the start of a credential pattern
// or sits inside a match that has not ended (a key=value value, a Bearer/Basic token, an sk- key, or a whole-message
// rule such as JSON text / a leading secret prefix / text after a `?`), until a delimiter arrives or the message ends.
// There is no fixed-length tail and no line / sentence buffering. Hard cap: a held tail longer than
// STREAM_MASK_HOLD_MAX is released as `***`; the rest of that match is dropped (up to the next delimiter for a local
// match, to the end of the message for a whole-message rule). The completed message (message.completed) carries the
// canonical masked text.
import { maskArgsDeep } from "./mask-args.js";
import { MASK } from "./sensitive.js";

/** Longest held (not yet released) tail, in UTF-16 code units. */
export const STREAM_MASK_HOLD_MAX = 4096;

export interface StreamMasker {
  /** Feeds raw model text; returns the masked text that became stable (may be ""). */
  push(piece: string): string;
  /** The message is complete; returns the masked remainder. */
  end(): string;
}

const DELIMITER = /[\s,;，；。"'()（）<>]/;
const KEYS = "password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|密码|口令|密钥|令牌";
// Spelled-out forms of KEYS (and the prefix words) used for "the tail could still become one of these".
const KEY_WORDS = [
  "password", "passwd", "pwd", "secret", "client_secret", "client-secret", "clientsecret", "api_key", "api-key", "apikey",
  "access_token", "access-token", "accesstoken", "refresh_token", "refresh-token", "refreshtoken", "id_token", "id-token", "idtoken",
  "token", "sk-",
];
const PREFIX_WORDS = ["bearer", "basic"];
const CJK_KEY_STARTS = /[密口令]$/;
const OPEN_KEY_VALUE = new RegExp(`(^|[^\\w-])((?:${KEYS})\\s*[=:：]\\s*)[^\\s,;，；。"'()（）<>]*$`, "i");
const OPEN_KEY = new RegExp(`(^|[^\\w-])(?:${KEYS})\\s*$`, "i");
const OPEN_BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]*$/i;
const OPEN_BASIC = /\b(basic\s+)[A-Za-z0-9+/=]*$/i;
const OPEN_SK = /(^|[^\w-])sk-[A-Za-z0-9_-]*$/;
// Whole-message rules of maskArgsDeep (isSecretValue / JSON-like / URL query), checked on the trimmed message start.
const WHOLE_PREFIXES = ["bearer ", "basic ", "sk-", "ghp_", "xox", "eyj"];
const JWT_OPEN = /^eyJ[\w-]*(?:\.[\w-]*){0,2}\s*$/;

interface Hold {
  /** Start of the held tail. */
  at: number;
  /** Where the secret value itself starts (text before it may be released when the cap is hit). */
  valueAt: number;
  /** A whole-message rule: hitting the cap drops the rest of the message, not just up to a delimiter. */
  whole: boolean;
}

function wholeHold(buf: string): Hold | null {
  const text = buf.trimStart();
  const lower = text.toLowerCase();
  const all = { at: 0, valueAt: 0, whole: true };
  if (!text) return all;
  if (WHOLE_PREFIXES.some((p) => lower.startsWith(p) || p.startsWith(lower))) return all;
  if (JWT_OPEN.test(text)) return all;
  if ((text.startsWith("{") || text.startsWith("[")) && (text.slice(1).trim() === "" || /^["'{[]/.test(text.slice(1).trimStart()))) return all;
  const q = buf.indexOf("?");
  if (q !== -1) return { at: q + 1, valueAt: q + 1, whole: true };
  return null;
}

function localHold(buf: string): Hold | null {
  const holds: Hold[] = [];
  const kv = OPEN_KEY_VALUE.exec(buf);
  if (kv) {
    const at = kv.index + kv[1]!.length;
    holds.push({ at, valueAt: at + kv[2]!.length, whole: false });
  }
  const key = OPEN_KEY.exec(buf);
  if (key) {
    const at = key.index + key[1]!.length;
    holds.push({ at, valueAt: buf.length, whole: false });
  }
  for (const re of [OPEN_BEARER, OPEN_BASIC]) {
    const m = re.exec(buf);
    if (m) holds.push({ at: m.index, valueAt: m.index + m[1]!.length, whole: false });
  }
  const sk = OPEN_SK.exec(buf);
  if (sk) {
    const at = sk.index + sk[1]!.length;
    holds.push({ at, valueAt: at, whole: false });
  }
  const frag = /[\w-]+$/.exec(buf);
  if (frag) {
    const f = frag[0].toLowerCase();
    if (KEY_WORDS.some((w) => w.startsWith(f))) holds.push({ at: frag.index, valueAt: buf.length, whole: false });
  }
  const word = /\w+$/.exec(buf);
  if (word) {
    const w = word[0].toLowerCase();
    if (PREFIX_WORDS.some((p) => p.startsWith(w)) || KEY_WORDS.some((k) => k.startsWith(w))) holds.push({ at: word.index, valueAt: buf.length, whole: false });
  }
  if (CJK_KEY_STARTS.test(buf)) holds.push({ at: buf.length - 1, valueAt: buf.length, whole: false });
  if (!holds.length) return null;
  return holds.reduce((a, b) => (b.at < a.at ? b : a));
}

const mask = (text: string): string => maskArgsDeep(text) as string;

export function createStreamMasker(maxHold = STREAM_MASK_HOLD_MAX): StreamMasker {
  let buf = "";
  let sent = "";
  let first = true;
  let mode: "normal" | "skip" | "drop" = "normal";

  const releaseUpTo = (end: number): string => {
    const stable = mask(buf.slice(0, end));
    if (!stable.startsWith(sent)) return "";
    const out = stable.slice(sent.length);
    sent = stable;
    return out;
  };

  return {
    push(piece: string): string {
      if (!piece || mode === "drop") return "";
      if (mode === "skip") {
        const at = piece.search(DELIMITER);
        if (at === -1) return "";
        mode = "normal";
        buf = "";
        sent = "";
        first = false;
        piece = piece.slice(at);
      }
      buf += piece;
      const holds = [first ? wholeHold(buf) : null, localHold(buf)].filter((h): h is Hold => h !== null);
      if (!holds.length) return releaseUpTo(buf.length);
      const hold = holds.reduce((a, b) => (b.at < a.at ? b : a));
      if (buf.length - hold.at <= maxHold) return releaseUpTo(hold.at);
      const out = `${releaseUpTo(Math.min(hold.valueAt, buf.length))}${MASK}`;
      mode = hold.whole ? "drop" : "skip";
      buf = "";
      sent = "";
      return out;
    },
    end(): string {
      if (mode !== "normal") return "";
      return releaseUpTo(buf.length);
    },
  };
}
