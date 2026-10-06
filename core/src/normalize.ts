// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/core  ·  normalization + redaction (spec §6)
//
// Turns arbitrary captured values into plain JSON that is safe to send:
// cycles, depth, key/array counts are bounded and credentials are scrubbed.
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS, REDACTED } from './constants';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'apikey',
  'xapikey',
  'apisecret',
  'privatekey',
  'creditcard',
  'cardnumber',
  'ccnumber',
  'cvv',
  'cvc',
  'ssn',
  'sessiontoken',
]);

const SENSITIVE_SUBSTRINGS = ['password', 'secret', 'credential'];

export interface NormalizeOptions {
  /** Extra key names to redact, compared the same way as the built-in list. */
  redactKeys?: readonly string[];
}

function canonicalKey(key: string): string {
  return key.toLowerCase().replace(/[-_. ]/g, '');
}

/** Whether a value stored under `key` must be replaced with `[REDACTED]`. */
export function isSensitiveKey(key: string, extra?: ReadonlySet<string>): boolean {
  const k = canonicalKey(key);
  if (SENSITIVE_KEYS.has(k) || extra?.has(k)) return true;
  if (k.endsWith('token')) return true;
  for (const part of SENSITIVE_SUBSTRINGS) if (k.includes(part)) return true;
  return false;
}

// ── String scrubbing ─────────────────────────────────────────────────────────

const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi;
const LIVE_KEY = /\bwup_live_[A-Za-z0-9]+/g;
const SENSITIVE_QUERY = /([?&](?:token|access_token|password|api_key|apikey|secret|key)=)[^&#\s"']*/gi;
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Remove credentials and card numbers embedded in free text. */
export function scrubString(value: string): string {
  if (value.length < 8) return value;
  let out = value;
  if (/bearer|basic/i.test(out)) out = out.replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  if (out.indexOf('wup_live_') !== -1) out = out.replace(LIVE_KEY, REDACTED);
  if (out.indexOf('=') !== -1) out = out.replace(SENSITIVE_QUERY, (_m, prefix: string) => `${prefix}${REDACTED}`);
  if (/\d{4}/.test(out)) {
    out = out.replace(CARD_CANDIDATE, (match) => {
      const digits = match.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? REDACTED : match;
    });
  }
  return out;
}

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * Convert `value` into JSON-safe data and redact it. Never throws.
 * `undefined` means "omit" (object keys) — arrays get `null` like JSON does.
 */
export function normalize(value: unknown, options: NormalizeOptions = {}): unknown {
  const extra = options.redactKeys?.length
    ? new Set(options.redactKeys.map(canonicalKey))
    : undefined;
  const ancestors: object[] = [];

  const walk = (input: unknown, depth: number): unknown => {
    switch (typeof input) {
      case 'string':
        return scrubString(input);
      case 'number':
        return Number.isFinite(input) ? input : null;
      case 'boolean':
        return input;
      case 'bigint':
        return input.toString();
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined;
    }
    if (input === null) return null;

    const obj = input as object;
    if (ancestors.indexOf(obj) !== -1) return '[Circular]';
    if (depth >= LIMITS.MAX_DEPTH) return '[MaxDepth]';

    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    if (typeof ArrayBuffer !== 'undefined' && (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer)) {
      return `[Binary ${(obj as ArrayBuffer).byteLength} bytes]`;
    }

    ancestors.push(obj);
    try {
      if (obj instanceof Error) {
        const out: Record<string, unknown> = { name: obj.name, message: scrubString(obj.message) };
        if (obj.stack) out.stack = scrubString(obj.stack);
        for (const key of Object.keys(obj)) {
          if (key in out) continue;
          out[key] = isSensitiveKey(key, extra) ? REDACTED : walk((obj as unknown as Record<string, unknown>)[key], depth + 1);
        }
        return out;
      }

      const toJSON = (obj as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function' && !Array.isArray(obj)) {
        try {
          return walk(toJSON.call(obj), depth + 1);
        } catch {
          return '[Unserializable]';
        }
      }

      if (Array.isArray(obj) || (typeof Set !== 'undefined' && obj instanceof Set)) {
        const list = Array.isArray(obj) ? obj : Array.from(obj as Set<unknown>);
        const out: unknown[] = [];
        const limit = Math.min(list.length, LIMITS.MAX_ARRAY);
        for (let i = 0; i < limit; i++) {
          const v = walk(list[i], depth + 1);
          out.push(v === undefined ? null : v);
        }
        if (list.length > limit) out.push(`[… ${list.length - limit} more]`);
        return out;
      }

      const entries: Array<[string, unknown]> =
        typeof Map !== 'undefined' && obj instanceof Map
          ? Array.from(obj.entries()).map(([k, v]) => [String(k), v])
          : Object.keys(obj).map((k) => [k, (obj as Record<string, unknown>)[k]]);

      const out: Record<string, unknown> = {};
      let kept = 0;
      for (const [key, raw] of entries) {
        if (kept >= LIMITS.MAX_KEYS) {
          out._watchup_dropped_keys = entries.length - kept;
          break;
        }
        if (isSensitiveKey(key, extra)) {
          out[key] = REDACTED;
          kept++;
          continue;
        }
        const v = walk(raw, depth + 1);
        if (v === undefined) continue;
        out[key] = v;
        kept++;
      }
      return out;
    } finally {
      ancestors.pop();
    }
  };

  try {
    return walk(value, 0);
  } catch {
    return '[Unserializable]';
  }
}
