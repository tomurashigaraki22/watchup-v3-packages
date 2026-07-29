// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/nextjs  ·  Server-side singleton
//
// Use this in API routes, Route Handlers, and Server Actions.
// The singleton is initialised lazily on first use and is safe in both the
// Pages Router (one Node process) and App Router (module caching per worker).
// ─────────────────────────────────────────────────────────────────────────────

import { Watchup as NodeWatchup, type WatchupOptions } from '@watchupltd/node';
import { createNoopWatchup } from './noop.js';

let _instance: NodeWatchup | null = null;
let _warnedMissingApiKey = false;

/**
 * Returns the shared server-side Watchup instance, creating it on first call.
 *
 * Call `initWatchup()` explicitly in your app bootstrap (e.g.
 * `instrumentation.ts`) to set options up-front; otherwise the first call to
 * `getWatchup()` will initialise with whatever env vars are present.
 *
 * @example
 * // instrumentation.ts
 * import { initWatchup } from '@watchupltd/nextjs/server';
 *
 * export function register() {
 *   initWatchup({
 *     apiKey:      process.env.WATCHUP_API_KEY!,
 *     environment: process.env.NODE_ENV,
 *   });
 * }
 */
export function initWatchup(options?: Partial<WatchupOptions>): NodeWatchup {
  if (!_instance) {
    const apiKey = options?.apiKey ?? process.env.WATCHUP_API_KEY ?? '';
    if (!apiKey) {
      if (!_warnedMissingApiKey) {
        console.warn(
          '[watchup] Server SDK disabled because no apiKey was provided. ' +
          'Pass apiKey to initWatchup() or set WATCHUP_API_KEY to enable monitoring.',
        );
        _warnedMissingApiKey = true;
      }
      _instance = createNoopWatchup();
      return _instance;
    }
    _instance = new NodeWatchup({
      environment: process.env.NODE_ENV,
      ...options,
      apiKey,
    });
  }
  return _instance;
}

/**
 * Returns the shared server-side Watchup instance.
 * Throws if `initWatchup()` has not been called yet.
 */
export function getWatchup(): NodeWatchup {
  if (!_instance) {
    // Auto-init from env for convenience
    return initWatchup();
  }
  return _instance;
}
