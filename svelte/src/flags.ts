// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/svelte  ·  feature flag helpers
// ─────────────────────────────────────────────────────────────────────────────

import type { FlagContext } from '@watchupltd/browser';
import { getWatchup } from './context.js';

/**
 * Check whether a feature flag is enabled for the current visitor/user.
 *
 * @example
 * import { isFlagEnabled } from '@watchupltd/svelte';
 * {#if isFlagEnabled('new-checkout')}
 *   <NewCheckout />
 * {/if}
 */
export function isFlagEnabled(key: string, ctx?: FlagContext): boolean {
  return getWatchup().isEnabled(key, ctx);
}

/**
 * Get the variant key for a multivariate (A/B) flag.
 * Returns `"control"` if the flag is off or the visitor isn't in the rollout.
 *
 * @example
 * import { getFlagVariant } from '@watchupltd/svelte';
 * const variant = getFlagVariant('pricing-layout');
 */
export function getFlagVariant(key: string, ctx?: FlagContext): string {
  return getWatchup().getVariant(key, ctx);
}
