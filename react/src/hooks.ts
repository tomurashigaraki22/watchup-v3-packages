// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react  ·  hooks
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { Watchup, WatchupUser, TracePayload, FlagContext } from '@watchupltd/browser';
import { useWatchupContext } from './context.js';

type EndTrace = (opts?: { status?: TracePayload['status']; meta?: Record<string, unknown> }) => void;

/**
 * Returns the `Watchup` client from the nearest `<WatchupProvider>`
 * (a no-op client during server rendering).
 *
 * @example
 * const watchup = useWatchup();
 * watchup.track('checkout.started', { plan: 'pro' });
 */
export function useWatchup(): Watchup {
  return useWatchupContext();
}

/**
 * Stable `track` callback — safe in props and dependency arrays.
 *
 * @example
 * const track = useTrack();
 * <button onClick={() => track('button.clicked', { id: 'cta' })}>Get started</button>
 */
export function useTrack(): (name: string, properties?: Record<string, unknown>) => void {
  const watchup = useWatchupContext();
  return useCallback((name, props) => watchup.track(name, props), [watchup]);
}

/**
 * Stable `startTrace` callback.
 *
 * @example
 * const startTrace = useStartTrace();
 * const end = startTrace('form.submit /api/signup');
 * await submit();
 * end();
 */
export function useStartTrace(): (span: string) => EndTrace {
  const watchup = useWatchupContext();
  return useCallback((span: string) => watchup.startTrace(span), [watchup]);
}

/**
 * Identify the current user; pass `null` to clear (e.g. after logout).
 * Re-runs only when the user's id, email or name changes.
 *
 * @example
 * useIdentify(user ? { id: user.id, email: user.email } : null);
 */
export function useIdentify(user: WatchupUser | null | undefined): void {
  const watchup = useWatchupContext();
  const latest = useRef(user);
  latest.current = user;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when identity fields change, not on every new object
  useEffect(() => {
    if (latest.current) watchup.setUser(latest.current);
    else watchup.clearUser();
  }, [watchup, user?.id, user?.email, user?.name]);
}

/**
 * Record a page view whenever `path` changes. Use with your router and set
 * `autoCapture.pageViews: false` on the provider to avoid double counting.
 *
 * @example
 * const { pathname } = useLocation();
 * usePageView(pathname);
 */
export function usePageView(path: string): void {
  const watchup = useWatchupContext();
  const last = useRef<string | null>(null);
  useEffect(() => {
    // StrictMode runs effects twice; track each distinct path once.
    if (last.current === path) return;
    last.current = path;
    watchup.trackWebView();
  }, [watchup, path]);
}

function useFlagValue<T>(read: () => T, watchup: Watchup): T {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => watchup.onFlagsChange(onChange), [watchup]),
    read,
    read,
  );
}

/**
 * Whether a feature flag is enabled. Re-renders when the flag cache refreshes.
 *
 * @example
 * const newCheckout = useFlag('new-checkout');
 */
export function useFlag(key: string, ctx?: FlagContext): boolean {
  const watchup = useWatchupContext();
  const ctxKey = JSON.stringify(ctx ?? {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: ctx is compared by value through ctxKey
  const read = useCallback(() => watchup.isEnabled(key, ctx), [watchup, key, ctxKey]);
  return useFlagValue(read, watchup);
}

/**
 * Variant key for a multivariate flag (`"control"` when off).
 *
 * @example
 * const variant = useVariant('pricing-layout');
 */
export function useVariant(key: string, ctx?: FlagContext): string {
  const watchup = useWatchupContext();
  const ctxKey = JSON.stringify(ctx ?? {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: ctx is compared by value through ctxKey
  const read = useCallback(() => watchup.getVariant(key, ctx), [watchup, key, ctxKey]);
  return useFlagValue(read, watchup);
}
