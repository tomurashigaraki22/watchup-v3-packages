// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/core  ·  byte-aware chunker (spec §4)
//
// Bodies are assembled from items that were serialized once at capture time,
// so the measured byte count is exactly the size of the request body.
// ─────────────────────────────────────────────────────────────────────────────

import { utf8ByteLength } from './utf8';
import { KIND_ORDER, type Chunk, type EnvelopeBase, type Kind, type PreparedItem } from './types';

export interface ChunkLimits {
  maxBytes: number;
  maxItems: number;
}

const PREFIX_PARTS = ['{"errors":[', '],"traces":[', '],"events":[', '],'];
/** Bytes of `{"errors":[],"traces":[],"events":[],` — all ASCII. */
const FIXED_BYTES = PREFIX_PARTS.join('').length;

/** Serialized tail: base fields + idempotency_key + sent_at, without the leading `{`. */
function tail(base: EnvelopeBase, idempotencyKey: string, sentAt: string): string {
  return JSON.stringify({ ...base, idempotency_key: idempotencyKey, sent_at: sentAt }).slice(1);
}

/** Bytes of an envelope with no items — the per-chunk overhead. */
export function envelopeOverhead(base: EnvelopeBase, sentAt = '2026-01-01T00:00:00.000Z'): number {
  // Worst-case key: 36-char UUID and a 6-digit chunk index.
  const key = `wu_${'0'.repeat(36)}_999999`;
  return FIXED_BYTES + utf8ByteLength(tail(base, key, sentAt));
}

export function idempotencyKey(batchId: string, index: number): string {
  return `wu_${batchId}_${index}`;
}

export function assembleBody(
  groups: Record<Kind, string[]>,
  base: EnvelopeBase,
  key: string,
  sentAt: string,
): string {
  return (
    PREFIX_PARTS[0] + groups.errors.join(',') +
    PREFIX_PARTS[1] + groups.traces.join(',') +
    PREFIX_PARTS[2] + groups.events.join(',') +
    PREFIX_PARTS[3] + tail(base, key, sentAt)
  );
}

/**
 * Split pending items into chunks. Consumes items in priority order
 * (errors → traces → events), FIFO within each kind. An item larger than the
 * budget on its own is emitted as a single-item chunk.
 */
export function buildChunks(
  pending: Record<Kind, PreparedItem[]>,
  base: EnvelopeBase,
  limits: ChunkLimits,
  batchId: string,
  sentAt: string,
  now = 0,
): Chunk[] {
  const overhead = envelopeOverhead(base, sentAt);
  const chunks: Chunk[] = [];

  let groups: Record<Kind, string[]> = { errors: [], traces: [], events: [] };
  let bytes = overhead;
  let count = 0;

  const close = () => {
    if (!count) return;
    const key = idempotencyKey(batchId, chunks.length);
    const body = assembleBody(groups, base, key, sentAt);
    chunks.push({
      idempotencyKey: key,
      body,
      bytes: utf8ByteLength(body),
      counts: { errors: groups.errors.length, traces: groups.traces.length, events: groups.events.length },
      attempts: 0,
      nextAttemptAt: now,
    });
    groups = { errors: [], traces: [], events: [] };
    bytes = overhead;
    count = 0;
  };

  for (const kind of KIND_ORDER) {
    for (const item of pending[kind]) {
      const added = item.bytes + (groups[kind].length ? 1 : 0);
      if (count && (bytes + added > limits.maxBytes || count + 1 > limits.maxItems)) close();
      groups[kind].push(item.json);
      bytes += item.bytes + (groups[kind].length > 1 ? 1 : 0);
      count++;
      // An oversized item travels alone.
      if (bytes > limits.maxBytes) close();
    }
  }
  close();
  return chunks;
}
