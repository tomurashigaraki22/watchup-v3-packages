// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/svelte  ·  Svelte actions
//
// Actions run after component init, so they resolve the client through the
// active provider rather than getContext().
// ─────────────────────────────────────────────────────────────────────────────

import type { Action } from 'svelte/action';
import { _getActive } from './context.js';

export interface TrackClickParams {
  /** Event name sent to Watchup. */
  event: string;
  /** Optional properties merged into the event payload. */
  properties?: Record<string, unknown>;
}

/**
 * Track a click on the element.
 *
 * @example
 * <button use:trackClick={{ event: 'cta.clicked', properties: { variant: 'A' } }}>Get started</button>
 */
export const trackClick: Action<HTMLElement, TrackClickParams> = (node, params) => {
  let current = params;
  const handler = () => {
    if (current?.event) _getActive()?.track(current.event, current.properties);
  };
  node.addEventListener('click', handler);
  return {
    update(next: TrackClickParams) {
      current = next;
    },
    destroy() {
      node.removeEventListener('click', handler);
    },
  };
};

export interface TraceActionParams {
  /** Span name for the trace. */
  span: string;
  /** Receives `done()`; call it when the work the element represents is finished. */
  onDone?: (done: (opts?: { status?: 'ok' | 'warn' | 'err' }) => void) => void;
}

/**
 * Trace from the moment the element mounts until `done()` is called. If the
 * element is destroyed first, the trace is recorded as cancelled.
 *
 * @example
 * <div use:traceAction={{ span: 'dashboard load', onDone: (fn) => (done = fn) }}>…</div>
 */
export const traceAction: Action<HTMLElement, TraceActionParams> = (_node, params) => {
  const end = _getActive()?.startTrace(params.span) ?? (() => {});
  let finished = false;
  const done = (opts: { status?: 'ok' | 'warn' | 'err' } = {}) => {
    if (finished) return;
    finished = true;
    end({ status: opts.status ?? 'ok' });
  };
  params.onDone?.(done);
  return {
    destroy() {
      if (finished) return;
      finished = true;
      end({ status: 'warn', meta: { cancelled: true } });
    },
  };
};
