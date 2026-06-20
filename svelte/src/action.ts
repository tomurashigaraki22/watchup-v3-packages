// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/svelte  ·  Svelte actions
// ─────────────────────────────────────────────────────────────────────────────

import type { Action }  from 'svelte/action';
import type { Watchup } from '@watchupltd/browser';
import { getWatchup }  from './context.js';

interface TrackClickParams {
  /** Event name sent to Watchup. */
  event:       string;
  /** Optional properties merged into the event payload. */
  properties?: Record<string, unknown>;
}

/**
 * Svelte action that tracks a click event.
 *
 * @example
 * <script>
 *   import { trackClick } from '@watchupltd/svelte';
 * </script>
 * <button use:trackClick={{ event: 'cta.clicked', properties: { variant: 'A' } }}>
 *   Get started
 * </button>
 */
export const trackClick: Action<HTMLElement, TrackClickParams> = (
  node,
  params,
) => {
  let watchup: Watchup;
  try {
    watchup = getWatchup();
  } catch {
    // No provider in tree — silently no-op
    return {};
  }

  const handler = () => {
    watchup.track(params.event, params.properties);
  };

  node.addEventListener('click', handler);

  return {
    update(newParams) {
      params = newParams;
    },
    destroy() {
      node.removeEventListener('click', handler);
    },
  };
};

/**
 * Svelte action that traces the time between `mount` and when `done()` is
 * called, emitting a trace span.
 *
 * @example
 * <script>
 *   import { traceAction } from '@watchupltd/svelte';
 *
 *   let done: () => void;
 *
 *   async function load() {
 *     const data = await fetchData();
 *     done?.();
 *     return data;
 *   }
 * </script>
 * <div use:traceAction={{ span: 'dashboard load', onDone: (fn) => (done = fn) }}>
 *   ...
 * </div>
 */
export const traceAction: Action<
  HTMLElement,
  { span: string; onDone: (endFn: () => void) => void }
> = (node, params) => {
  let watchup: Watchup;
  try {
    watchup = getWatchup();
  } catch {
    params.onDone(() => {});
    return {};
  }

  const end = watchup.startTrace(params.span);
  params.onDone(() => end({ status: 'ok' }));

  return {
    destroy() {
      // If destroyed before done() was called, mark as cancelled
    },
  };
};
