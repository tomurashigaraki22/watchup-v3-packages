// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/svelte  ·  user identification helpers
// ─────────────────────────────────────────────────────────────────────────────

import type { WatchupUser } from '@watchupltd/browser';
import { getWatchup } from './context.js';

/**
 * Attach a user to all subsequent errors and traces.
 * Call this after login, inside a Svelte component or store subscription.
 *
 * @example
 * import { identify } from '@watchupltd/svelte';
 * identify({ id: $user.id, email: $user.email, name: $user.name });
 */
export function identify(user: WatchupUser): void {
  getWatchup().setUser(user);
}

/**
 * Remove the current user context (e.g. after logout).
 *
 * @example
 * import { clearUser } from '@watchupltd/svelte';
 * clearUser();
 */
export function clearUser(): void {
  getWatchup().clearUser();
}
