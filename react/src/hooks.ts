// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react  ·  hooks
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback } from 'react';
import type { Watchup, TracePayload } from '@watchupltd/browser';
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
export function useStartTrace(): (
  span: string,
) => (opts?: { status?: TracePayload['status']; meta?: Record<string, unknown> }) => void {
  const watchup = useWatchupContext();
  return useCallback((span: string) => watchup.startTrace(span), [watchup]);
}
