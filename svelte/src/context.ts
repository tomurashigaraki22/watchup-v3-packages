// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/svelte  ·  context helpers
// ─────────────────────────────────────────────────────────────────────────────

import { getContext, setContext } from 'svelte';
import type { Watchup }          from '@watchupltd/browser';

const KEY = Symbol('watchup');

/** Called internally by WatchupProvider. */
export function _setWatchupContext(instance: Watchup): void {
  setContext(KEY, instance);
}

/**
 * Returns the `Watchup` instance from the nearest `<WatchupProvider>`.
 * Call this at component initialisation time (not inside event handlers).
 *
 * @example
 * <script>
 *   import { getWatchup } from '@watchupltd/svelte';
 *   const watchup = getWatchup();
 * </script>
 * <button on:click={() => watchup.track('button.clicked')}>Click me</button>
 */
export function getWatchup(): Watchup {
  const instance = getContext<Watchup | undefined>(KEY);
  if (!instance) {
    throw new Error(
      '[watchup] getWatchup() must be called inside a component ' +
      'that is a descendant of <WatchupProvider>.',
    );
  }
  return instance;
}
