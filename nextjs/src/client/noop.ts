import type { Watchup } from '@watchupltd/browser';

const noopEndTrace = () => {};

export function createNoopWatchup(): Watchup {
  return {
    sessionId: 'watchup-disabled',
    setUser() {},
    clearUser() {},
    track() {},
    trackWebView() {},
    captureError() {},
    captureLog() {},
    startTrace() {
      return noopEndTrace;
    },
    isEnabled() {
      return false;
    },
    getVariant() {
      return 'control';
    },
    flush() {},
    shutdown() {},
  } as unknown as Watchup;
}
