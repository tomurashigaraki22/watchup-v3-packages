// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react-native  ·  global JS error and rejection capture
//
// Uncaught exceptions: ErrorUtils' global handler, chained so React Native's
// own handler (red box in dev, native crash handling in release) still runs.
// Unhandled rejections: Hermes' rejection tracker, or the `promise` polyfill's
// tracker on JSC. Native (Java/Kotlin/ObjC/Swift) crashes are not captured.
// ─────────────────────────────────────────────────────────────────────────────

type ErrorHandler = (error: Error, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler?: () => ErrorHandler;
  setGlobalHandler?: (handler: ErrorHandler) => void;
}

interface RejectionTrackerOptions {
  allRejections: boolean;
  onUnhandled: (id: number, error: unknown) => void;
  onHandled: (id: number) => void;
}

const g = globalThis as typeof globalThis & {
  ErrorUtils?: ErrorUtilsLike;
  HermesInternal?: { enablePromiseRejectionTracker?: (options: RejectionTrackerOptions) => void };
  __DEV__?: boolean;
};

export function captureGlobalErrors(capture: (error: unknown, isFatal: boolean) => void): () => void {
  const errorUtils = g.ErrorUtils;
  if (!errorUtils?.getGlobalHandler || !errorUtils.setGlobalHandler) return () => {};

  const previous = errorUtils.getGlobalHandler();
  const handler: ErrorHandler = (error, isFatal) => {
    try {
      capture(error, Boolean(isFatal));
    } catch {
      // Never let capture break React Native's own handling.
    }
    previous?.(error, isFatal);
  };
  errorUtils.setGlobalHandler(handler);

  return () => {
    if (errorUtils.getGlobalHandler?.() === handler) errorUtils.setGlobalHandler?.(previous);
  };
}

function rejectionTracker(): ((options: RejectionTrackerOptions) => void) | null {
  if (g.HermesInternal?.enablePromiseRejectionTracker) {
    return (options) => g.HermesInternal!.enablePromiseRejectionTracker!(options);
  }
  try {
    // JSC / older RN: the promise polyfill ships its own tracker.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tracking = require('promise/setimmediate/rejection-tracking') as { enable(o: RejectionTrackerOptions): void };
    return (options) => tracking.enable(options);
  } catch {
    return null;
  }
}

/**
 * Report unhandled promise rejections. Enabling a tracker replaces React
 * Native's default one, so the development warning is re-emitted here.
 */
export function captureUnhandledRejections(capture: (reason: unknown) => void): boolean {
  const enable = rejectionTracker();
  if (!enable) return false;
  enable({
    allRejections: true,
    onUnhandled: (_id, reason) => {
      if (g.__DEV__) console.warn('Possible unhandled promise rejection:', reason);
      try {
        capture(reason);
      } catch {
        // Ignore capture failures.
      }
    },
    onHandled: () => {},
  });
  return true;
}
