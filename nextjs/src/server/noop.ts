import type { Watchup as NodeWatchup } from '@watchupltd/node';

const noopEndTrace = () => {};

export function createNoopWatchup(): NodeWatchup {
  return {
    setUser() {},
    clearUser() {},
    requestMiddleware() {
      return (_req: unknown, _res: unknown, next?: () => void) => {
        if (typeof next === 'function') next();
      };
    },
    errorMiddleware() {
      return (err: unknown, _req: unknown, _res: unknown, next?: (error?: unknown) => void) => {
        if (typeof next === 'function') next(err);
      };
    },
    track() {},
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
  } as unknown as NodeWatchup;
}
