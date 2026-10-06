// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react  ·  no-op client
//
// Returned during server rendering, before the provider mounts, and when no
// apiKey is configured — so components can call hooks unconditionally.
// ─────────────────────────────────────────────────────────────────────────────

import type { Watchup } from '@watchupltd/browser';

const noopEnd = () => {};
const noopFlush = async () => ({ accepted: 0, deliveredItems: 0, retrying: 0, dropped: 0 });

export function createNoopWatchup(): Watchup {
  return {
    sessionId: 'watchup-disabled',
    isClosed: true,
    setUser() {},
    clearUser() {},
    track() {},
    trackWebView() {},
    captureError() {},
    captureLog() {},
    startTrace() {
      return noopEnd;
    },
    isEnabled() {
      return false;
    },
    getVariant() {
      return 'control';
    },
    onFlagsChange() {
      return () => {};
    },
    async refreshFlags() {},
    flush: noopFlush,
    async shutdown() {},
  } as unknown as Watchup;
}

export const noopWatchup = createNoopWatchup();
