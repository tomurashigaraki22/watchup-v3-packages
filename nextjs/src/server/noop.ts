import type { Watchup as NodeWatchup } from '@watchupltd/node';

const noopEndTrace = () => {};

export function createNoopWatchup(): NodeWatchup {
  return {
    setUser() {},
    clearUser() {},
    getContext() {
      return undefined;
    },
    runWithContext(_ctx: unknown, fn: () => unknown) {
      return fn();
    },
    wrapAsync(handler: unknown) {
      return handler;
    },
    async trace(_span: string, fn: () => unknown) {
      return fn();
    },
    async traceQuery(_sql: string, fn: () => unknown) {
      return fn();
    },
    async refreshFlags() {},
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
    async flush() {
      return { accepted: 0, deliveredItems: 0, retrying: 0, dropped: 0 };
    },
    async shutdown() {},
  } as unknown as NodeWatchup;
}
