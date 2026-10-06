// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/core  ·  truncation policy (spec §5)
//
// Only applied to an item that would not fit in an otherwise empty chunk.
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from './constants';
import { truncateWithMarker, utf8ByteLength } from './utf8';

type Json = Record<string, unknown>;

const CONTAINERS = ['context', 'meta', 'properties'] as const;

export interface FitResult {
  item: Json;
  json: string;
  bytes: number;
  truncated: boolean;
  /** Still larger than the budget after every truncation step. */
  oversized: boolean;
}

function capStrings(value: unknown, maxBytes: number): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const cut = truncateWithMarker(value, maxBytes);
    return { value: cut.value, changed: cut.truncated };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = capStrings(v, maxBytes);
      changed ||= r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      const r = capStrings(v, maxBytes);
      changed ||= r.changed;
      out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

function capField(item: Json, field: 'message' | 'stack', maxBytes: number): boolean {
  const value = item[field];
  if (typeof value !== 'string') return false;
  const cut = truncateWithMarker(value, maxBytes);
  if (cut.truncated) item[field] = cut.value;
  return cut.truncated;
}

function measure(item: Json): { json: string; bytes: number } {
  const json = JSON.stringify(item);
  return { json, bytes: utf8ByteLength(json) };
}

/**
 * Make a normalized item fit in `budget` bytes, following the contract's
 * three truncation steps. Returns the original item untouched if it fits.
 */
export function fitItem(item: Json, budget: number): FitResult {
  let current = measure(item);
  if (current.bytes <= budget) {
    return { item, ...current, truncated: false, oversized: false };
  }

  const out: Json = { ...item };
  let truncated = false;

  // Step 1 — cap message, stack, and every string inside the metadata bags.
  truncated = capField(out, 'message', LIMITS.TRUNCATE_MESSAGE_BYTES) || truncated;
  truncated = capField(out, 'stack', LIMITS.TRUNCATE_STACK_BYTES) || truncated;
  for (const key of CONTAINERS) {
    if (out[key] === undefined) continue;
    const r = capStrings(out[key], LIMITS.TRUNCATE_FIELD_BYTES);
    if (r.changed) {
      out[key] = r.value;
      truncated = true;
    }
  }
  out._watchup_truncated = true;
  current = measure(out);

  // Step 2 — replace the metadata bags with a size marker.
  if (current.bytes > budget) {
    for (const key of CONTAINERS) {
      if (out[key] === undefined) continue;
      out[key] = {
        _watchup_truncated: true,
        original_bytes: utf8ByteLength(JSON.stringify((item as Json)[key])),
      };
      truncated = true;
    }
    current = measure(out);
  }

  // Step 3 — final caps on message and stack.
  if (current.bytes > budget) {
    truncated = capField(out, 'message', LIMITS.TRUNCATE_MESSAGE_FINAL_BYTES) || truncated;
    truncated = capField(out, 'stack', LIMITS.TRUNCATE_STACK_FINAL_BYTES) || truncated;
    current = measure(out);
  }

  if (!truncated) {
    delete out._watchup_truncated;
    current = measure(out);
  }
  return { item: out, ...current, truncated, oversized: current.bytes > budget };
}
