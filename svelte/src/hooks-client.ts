// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/svelte  ·  SvelteKit client hook (hooks.client.ts)
// ─────────────────────────────────────────────────────────────────────────────

import { _getActive } from './context.js';

/**
 * `handleError` for `src/hooks.client.ts`: reports unexpected client-side
 * navigation and load errors through the mounted provider.
 *
 * @example
 * // src/hooks.client.ts
 * import { watchupHandleClientError } from '@watchupltd/svelte';
 * export const handleError = watchupHandleClientError();
 */
export function watchupHandleClientError() {
  return ({ error, status }: { error: unknown; status?: number }): void => {
    if (status !== undefined && status < 500) return;
    _getActive()?.captureError(error, { mechanism: 'sveltekit.handleError' });
  };
}
