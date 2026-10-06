// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/nextjs  ·  Server-side singleton
//
// One Node client per process, stored on globalThis so dev-server HMR and
// duplicated module instances (route bundles) share it. Node.js runtime only:
// the Edge runtime has no AsyncLocalStorage-backed process lifecycle to flush.
// ─────────────────────────────────────────────────────────────────────────────

import { Watchup as NodeWatchup, type WatchupOptions } from '@watchupltd/node';
import { createNoopWatchup } from './noop.js';

const KEY = Symbol.for('watchup.nextjs.server');

interface Holder {
  instance: NodeWatchup | null;
  warnedMissingKey: boolean;
}

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder | undefined>;
  return (g[KEY] ??= { instance: null, warnedMissingKey: false });
}

export function assertNodeRuntime(): void {
  if (process.env.NEXT_RUNTIME === 'edge') {
    throw new Error(
      '[watchup] @watchupltd/nextjs/server runs on the Node.js runtime only. ' +
      "Remove `export const runtime = 'edge'` from this route, or report from the browser with @watchupltd/nextjs/client.",
    );
  }
}

/**
 * Initialise the shared server client (idempotent — later calls return the
 * first instance). Call it from `instrumentation.ts`, or use `registerWatchup`.
 * Without an API key the SDK is disabled and a no-op client is returned.
 */
export function initWatchup(options?: Partial<WatchupOptions>): NodeWatchup {
  assertNodeRuntime();
  const h = holder();
  if (h.instance) return h.instance;

  const apiKey = options?.apiKey ?? process.env.WATCHUP_API_KEY ?? '';
  if (!apiKey) {
    if (!h.warnedMissingKey) {
      console.warn(
        '[watchup] Server SDK disabled because no apiKey was provided. ' +
        'Pass apiKey to initWatchup() or set WATCHUP_API_KEY to enable monitoring.',
      );
      h.warnedMissingKey = true;
    }
    h.instance = createNoopWatchup();
    return h.instance;
  }

  h.instance = new NodeWatchup({
    environment: process.env.NODE_ENV,
    ...options,
    apiKey,
  });
  return h.instance;
}

/** The shared server client, initialised from env vars on first use. */
export function getWatchup(): NodeWatchup {
  return holder().instance ?? initWatchup();
}

/**
 * For `instrumentation.ts`: initialise exactly once, on the Node.js runtime
 * only (Next calls `register` for every runtime).
 *
 * @example
 * // instrumentation.ts
 * import { registerWatchup } from '@watchupltd/nextjs/server';
 * export const register = () => registerWatchup({ release: process.env.GIT_SHA });
 */
export function registerWatchup(options?: Partial<WatchupOptions>): void {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;
  initWatchup(options);
}

/** Test helper: forget the singleton. */
export async function _resetWatchup(): Promise<void> {
  const h = holder();
  await h.instance?.shutdown();
  h.instance = null;
  h.warnedMissingKey = false;
}
