// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/svelte  ·  feature flag helpers
// ─────────────────────────────────────────────────────────────────────────────

import { readable, type Readable } from 'svelte/store';
import type { FlagContext } from '@watchupltd/browser';
import { getWatchup } from './context.js';

/**
 * Whether a flag is enabled right now (no reactivity — see `flag()`).
 *
 * @example
 * if (isFlagEnabled('new-checkout')) { ... }
 */
export function isFlagEnabled(key: string, ctx?: FlagContext): boolean {
  return getWatchup().isEnabled(key, ctx);
}

/** Variant key for a multivariate flag; `"control"` when off. */
export function getFlagVariant(key: string, ctx?: FlagContext): string {
  return getWatchup().getVariant(key, ctx);
}

/**
 * A store that updates whenever the flag cache refreshes. Call during
 * component init.
 *
 * @example
 * <script>
 *   import { flag } from '@watchupltd/svelte';
 *   const newCheckout = flag('new-checkout');
 * </script>
 * {#if $newCheckout}<NewCheckout />{/if}
 */
export function flag(key: string, ctx?: FlagContext): Readable<boolean> {
  const handle = getWatchup();
  return readable(handle.isEnabled(key, ctx), (set) => {
    set(handle.isEnabled(key, ctx));
    return handle.onFlagsChange(() => set(handle.isEnabled(key, ctx)));
  });
}

/** Store variant of `getFlagVariant`. */
export function variant(key: string, ctx?: FlagContext): Readable<string> {
  const handle = getWatchup();
  return readable(handle.getVariant(key, ctx), (set) => {
    set(handle.getVariant(key, ctx));
    return handle.onFlagsChange(() => set(handle.getVariant(key, ctx)));
  });
}
