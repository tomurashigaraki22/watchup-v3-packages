// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react  ·  React context
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext } from 'react';
import type { Watchup } from '@watchupltd/browser';
import { noopWatchup } from './noop.js';

export const WatchupContext = createContext<Watchup | null>(null);

/**
 * Returns the nearest `Watchup` instance. During server rendering (or before
 * the provider has a client) it returns a no-op client, so hooks never throw
 * in SSR. Outside any `<WatchupProvider>` it throws a helpful error.
 */
export function useWatchupContext(): Watchup {
  const instance = useContext(WatchupContext);
  if (instance === null) {
    throw new Error('[watchup] useWatchup() must be called inside a <WatchupProvider>.');
  }
  return instance;
}

export { noopWatchup };
