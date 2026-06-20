// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react  ·  React context
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext } from 'react';
import type { Watchup } from '@watchupltd/browser';

export const WatchupContext = createContext<Watchup | null>(null);

/**
 * Returns the nearest `Watchup` instance from context.
 * Throws a helpful error if used outside `<WatchupProvider>`.
 */
export function useWatchupContext(): Watchup {
  const instance = useContext(WatchupContext);
  if (!instance) {
    throw new Error(
      '[watchup] useWatchup() must be called inside a <WatchupProvider>.',
    );
  }
  return instance;
}
