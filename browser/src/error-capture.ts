// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/browser  ·  global error capture
// ─────────────────────────────────────────────────────────────────────────────

export interface CapturedGlobalError {
  error: unknown;
  message: string;
  context: Record<string, unknown>;
}

/**
 * Attaches `error` and `unhandledrejection` listeners and forwards each one
 * to `onError`, which builds the payload (so user, route and device context
 * are attached at capture time). Returns a cleanup function.
 */
export function captureGlobalErrors(onError: (captured: CapturedGlobalError) => void): () => void {
  const handleError = (event: ErrorEvent) => {
    // Resource load failures (img/script 404s) arrive without an Error object
    // and without a message; they are not JavaScript exceptions.
    if (!event.message && !event.error) return;
    onError({
      error: event.error,
      message: event.message || 'Unknown error',
      context: {
        mechanism: 'onerror',
        ...(event.filename && { source: event.filename }),
        ...(event.lineno && { line: event.lineno }),
        ...(event.colno && { col: event.colno }),
      },
    });
  };

  const handleRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    onError({
      error: reason,
      message: reason instanceof Error ? reason.message : String(reason ?? 'Unhandled Promise rejection'),
      context: { mechanism: 'unhandledrejection' },
    });
  };

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleRejection);

  return () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleRejection);
  };
}
