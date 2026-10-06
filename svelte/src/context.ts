// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/svelte  ·  context helpers
// ─────────────────────────────────────────────────────────────────────────────

import { getContext, setContext } from 'svelte';
import { WatchupHandle } from './client.js';

const KEY = Symbol.for('watchup.svelte');

/**
 * The most recently mounted provider's handle. Actions and event handlers run
 * outside component initialisation, where getContext() is not allowed, so
 * they fall back to this.
 */
let active: WatchupHandle | null = null;

/** Called internally by WatchupProvider during component init. */
export function _createWatchupContext(): WatchupHandle {
  const handle = new WatchupHandle();
  setContext(KEY, handle);
  return handle;
}

export function _setActive(handle: WatchupHandle | null): void {
  active = handle;
}

export function _getActive(): WatchupHandle | null {
  return active;
}

/**
 * Returns the WatchUp handle from the nearest `<WatchupProvider>`. Works during
 * component init and — via the active provider — in actions and event
 * handlers. Safe during SSR (calls are no-ops on the server).
 *
 * @example
 * <script>
 *   import { getWatchup } from '@watchupltd/svelte';
 *   const watchup = getWatchup();
 * </script>
 * <button on:click={() => watchup.track('button.clicked')}>Click me</button>
 */
export function getWatchup(): WatchupHandle {
  let fromContext: WatchupHandle | undefined;
  try {
    fromContext = getContext<WatchupHandle | undefined>(KEY);
  } catch {
    // Outside component init (actions, handlers) — use the active provider.
  }
  const handle = fromContext ?? active;
  if (!handle) {
    throw new Error('[watchup] getWatchup() needs a <WatchupProvider> higher in the component tree.');
  }
  return handle;
}
