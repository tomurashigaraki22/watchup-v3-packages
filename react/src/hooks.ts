// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react  ·  hooks
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import type { Watchup, WatchupUser, TracePayload, FlagContext } from '@watchupltd/browser';
import { useWatchupContext } from './context.js';

// ── useWatchup ────────────────────────────────────────────────────────────────

/**
 * Returns the `Watchup` instance from the nearest `<WatchupProvider>`.
 *
 * @example
 * const watchup = useWatchup();
 * watchup.track('checkout.started', { plan: 'pro' });
 */
export function useWatchup(): Watchup {
  return useWatchupContext();
}

// ── useTrack ──────────────────────────────────────────────────────────────────

/**
 * Returns a stable `track` callback — safe to pass as a prop or include in
 * dependency arrays without causing unnecessary re-renders.
 *
 * @example
 * const track = useTrack();
 * <button onClick={() => track('button.clicked', { id: 'cta' })}>
 *   Get started
 * </button>
 */
export function useTrack(): (name: string, properties?: Record<string, unknown>) => void {
  const watchup = useWatchupContext();
  return useCallback(
    (name: string, props?: Record<string, unknown>) => watchup.track(name, props),
    [watchup],
  );
}

// ── useStartTrace ─────────────────────────────────────────────────────────────

/**
 * Returns a stable `startTrace` callback.
 *
 * @example
 * const startTrace = useStartTrace();
 *
 * const handleSubmit = async () => {
 *   const end = startTrace('form.submit /api/signup');
 *   await submitForm(data);
 *   end({ status: 'ok' });
 * };
 */
// ── useIdentify ───────────────────────────────────────────────────────────────

/**
 * Identify the current user so all errors and traces are linked to them.
 * Pass `null` to clear (e.g. after logout).
 *
 * @example
 * const { user } = useAuth();
 * useIdentify(user ? { id: user.id, email: user.email, name: user.name } : null);
 */
export function useIdentify(user: WatchupUser | null | undefined): void {
  const watchup = useWatchupContext();
  useEffect(() => {
    if (user) {
      watchup.setUser(user);
    } else {
      watchup.clearUser();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
}

export function useStartTrace(): (
  span: string,
) => (opts?: { status?: TracePayload['status']; meta?: Record<string, unknown> }) => void {
  const watchup = useWatchupContext();
  return useCallback((span: string) => watchup.startTrace(span), [watchup]);
}

// ── useFlag ───────────────────────────────────────────────────────────────────

/**
 * Returns whether a feature flag is enabled. Re-evaluates when the SDK
 * refreshes its flag cache (every 30s) or when `key`/`ctx` change.
 *
 * @example
 * const newCheckout = useFlag('new-checkout');
 * return newCheckout ? <NewCheckout /> : <OldCheckout />;
 */
export function useFlag(key: string, ctx?: FlagContext): boolean {
  const watchup = useWatchupContext();
  const [enabled, setEnabled] = useState(() => watchup.isEnabled(key, ctx));

  useEffect(() => {
    setEnabled(watchup.isEnabled(key, ctx));
    const id = setInterval(() => setEnabled(watchup.isEnabled(key, ctx)), 5_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchup, key, JSON.stringify(ctx)]);

  return enabled;
}

// ── useVariant ────────────────────────────────────────────────────────────────

/**
 * Returns the variant key for a multivariate (A/B) flag.
 * Returns `"control"` if the flag is off or the user isn't in the rollout.
 *
 * @example
 * const variant = useVariant('pricing-layout');
 * // → "control" | "variant-a" | "variant-b"
 */
export function useVariant(key: string, ctx?: FlagContext): string {
  const watchup = useWatchupContext();
  const [variant, setVariant] = useState(() => watchup.getVariant(key, ctx));

  useEffect(() => {
    setVariant(watchup.getVariant(key, ctx));
    const id = setInterval(() => setVariant(watchup.getVariant(key, ctx)), 5_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchup, key, JSON.stringify(ctx)]);

  return variant;
}
