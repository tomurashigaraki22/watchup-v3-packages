// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react  ·  shared client registry
//
// One browser client per (apiKey, baseUrl). Providers retain it while
// mounted; it is shut down shortly after the last provider unmounts. The delay
// lets React StrictMode's mount → unmount → mount cycle reuse the same client,
// so development remounts never duplicate listeners or queues.
// ─────────────────────────────────────────────────────────────────────────────

import { Watchup, type WatchupOptions } from '@watchupltd/browser';

interface Entry {
  client: Watchup;
  refs: number;
  pendingShutdown: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();

function keyOf(options: WatchupOptions): string {
  return `${options.apiKey}|${options.baseUrl ?? ''}`;
}

/** Return the shared client for these options, creating it if needed. */
export function acquireClient(options: WatchupOptions): Watchup {
  const key = keyOf(options);
  const existing = entries.get(key);
  if (existing && !existing.client.isClosed) return existing.client;
  const client = new Watchup(options);
  entries.set(key, { client, refs: 0, pendingShutdown: null });
  return client;
}

export function retainClient(client: Watchup): void {
  for (const entry of entries.values()) {
    if (entry.client !== client) continue;
    entry.refs++;
    if (entry.pendingShutdown) {
      clearTimeout(entry.pendingShutdown);
      entry.pendingShutdown = null;
    }
  }
}

export function releaseClient(client: Watchup, delayMs = 100): void {
  for (const [key, entry] of entries) {
    if (entry.client !== client) continue;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0 || entry.pendingShutdown) return;
    entry.pendingShutdown = setTimeout(() => {
      if (entry.refs > 0) return;
      entries.delete(key);
      void entry.client.shutdown();
    }, delayMs);
  }
}

/** Test helper: forget every client without shutting it down. */
export function _resetRegistry(): void {
  for (const entry of entries.values()) if (entry.pendingShutdown) clearTimeout(entry.pendingShutdown);
  entries.clear();
}
