// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  unsent-chunk store
//
// Browsers cap in-flight beacon/keepalive data at ~64 KiB per page. Chunks the
// browser refuses during unload are kept in localStorage (already redacted,
// bounded in size) and resent with their original idempotency key on the next
// page load or when the tab becomes visible again, so a duplicate send is
// harmless.
// ─────────────────────────────────────────────────────────────────────────────

import type { Chunk, QueueSnapshot } from '@watchupltd/core';

const KEY = '__wup_unsent_v1';
const MAX_STORED_BYTES = 256 * 1024;

type Stored = QueueSnapshot['retry'][number];

function read(): Stored[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Stored[]) : [];
    return Array.isArray(list) ? list.filter((c) => typeof c?.body === 'string' && typeof c.idempotencyKey === 'string') : [];
  } catch {
    return [];
  }
}

function write(list: Stored[]): void {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage full or blocked: nothing else we can do during unload.
  }
}

/** Keep a chunk for the next page load. Returns false if it could not be stored. */
export function saveUnsent(chunk: Chunk): boolean {
  const list = read().filter((c) => c.idempotencyKey !== chunk.idempotencyKey);
  list.push({ idempotencyKey: chunk.idempotencyKey, body: chunk.body, bytes: chunk.bytes, counts: chunk.counts, attempts: chunk.attempts });
  let total = list.reduce((n, c) => n + c.bytes, 0);
  while (list.length && total > MAX_STORED_BYTES) total -= list.shift()!.bytes;
  write(list);
  return list.some((c) => c.idempotencyKey === chunk.idempotencyKey);
}

export function forgetUnsent(idempotencyKey: string): void {
  const list = read();
  const next = list.filter((c) => c.idempotencyKey !== idempotencyKey);
  if (next.length !== list.length) write(next);
}

/** Remove and return everything stored by a previous page. */
export function takeUnsent(): Stored[] {
  const list = read();
  if (list.length) write([]);
  return list;
}
