// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  global error capture
// ─────────────────────────────────────────────────────────────────────────────

import type { ErrorPayload } from './types.js';

type ErrorCallback = (error: ErrorPayload) => void;

/**
 * Attaches `window.onerror` and `window.addEventListener('unhandledrejection')`
 * listeners that forward caught errors to `onError`.
 *
 * Returns a cleanup function that removes both listeners.
 */
export function captureGlobalErrors(onError: ErrorCallback, env?: string): () => void {
  const handleError = (event: ErrorEvent) => {
    onError({
      message:   event.message || 'Unknown error',
      level:     'error',
      route:     window.location.pathname,
      stack:     event.error?.stack,
      context: {
        url:    window.location.href,
        source: event.filename ?? undefined,
        line:   event.lineno  ?? undefined,
        col:    event.colno   ?? undefined,
      },
      timestamp:   new Date().toISOString(),
      ...(env && { environment: env }),
    });
  };

  const handleRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const isErr  = reason instanceof Error;
    onError({
      message:   isErr ? reason.message : String(reason ?? 'Unhandled Promise rejection'),
      level:     'error',
      route:     window.location.pathname,
      stack:     isErr ? reason.stack : undefined,
      context: {
        url:  window.location.href,
        type: 'unhandledrejection',
      },
      timestamp:   new Date().toISOString(),
      ...(env && { environment: env }),
    });
  };

  window.addEventListener('error',              handleError);
  window.addEventListener('unhandledrejection', handleRejection);

  return () => {
    window.removeEventListener('error',              handleError);
    window.removeEventListener('unhandledrejection', handleRejection);
  };
}
