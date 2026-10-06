// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/core  ·  SQL statement sanitizer for database spans
//
// Span names must never carry credentials or unbounded parameter values, so
// literals are replaced with `?` and the statement is capped at 1 KiB.
// Parameters passed separately to a driver are never recorded.
// ─────────────────────────────────────────────────────────────────────────────

import { truncateUtf8 } from './utf8';

export const MAX_STATEMENT_BYTES = 1024;

export function sanitizeSql(sql: string): string {
  const out = sql
    .replace(/--[^\n]*/g, ' ')                 // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ')         // block comments
    .replace(/'(?:[^']|'')*'/g, '?')           // 'string literals'
    .replace(/\$\$[\s\S]*?\$\$/g, '?')         // $$dollar quoted$$
    .replace(/\b0x[0-9a-f]+\b/gi, '?')         // hex literals
    // Numbers, but not `$1` placeholders or identifiers like `t1`. No
    // lookbehind: it is a syntax error in Safari < 16.4.
    .replace(/(^|[^\w$])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, '$1?')
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?)') // IN (?, ?, ?) → (?)
    .replace(/\s+/g, ' ')
    .trim();
  return truncateUtf8(out, MAX_STATEMENT_BYTES).value;
}
