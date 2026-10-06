// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react  ·  WatchupProvider
//
// Client-only and StrictMode-safe: the browser client is shared through a
// registry (see registry.ts), so double renders and development remounts reuse
// one client and never duplicate listeners. During SSR the context holds a
// no-op client.
// ─────────────────────────────────────────────────────────────────────────────

'use client'; // Next.js App Router guard (ignored in plain React)

import { useEffect, useState, type ReactNode } from 'react';
import type { Watchup, WatchupOptions } from '@watchupltd/browser';
import { WatchupContext } from './context.js';
import { noopWatchup } from './noop.js';
import { acquireClient, releaseClient, retainClient } from './registry.js';

export interface WatchupProviderProps {
  /** Watchup project **public** key (`wup_pub_…`). */
  apiKey?: string;
  /** SDK options (apiKey is a top-level prop). */
  options?: Omit<WatchupOptions, 'apiKey'>;
  /** Use a client you created yourself instead (it is not shut down on unmount). */
  client?: Watchup;
  children: ReactNode;
}

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
let warnedMissingKey = false;

/**
 * Mount once near the root of your application.
 *
 * @example
 * <WatchupProvider apiKey={import.meta.env.VITE_WATCHUP_API_KEY}>
 *   <App />
 * </WatchupProvider>
 */
export function WatchupProvider({ apiKey, options, client, children }: WatchupProviderProps) {
  const [instance] = useState<Watchup>(() => {
    if (client) return client;
    if (!isBrowser) return noopWatchup;
    if (!apiKey) {
      if (!warnedMissingKey) {
        warnedMissingKey = true;
        console.warn('[watchup] Monitoring is disabled because <WatchupProvider> has no apiKey.');
      }
      return noopWatchup;
    }
    return acquireClient({ ...options, apiKey });
  });

  useEffect(() => {
    if (client || instance === noopWatchup) return undefined;
    retainClient(instance);
    return () => releaseClient(instance);
  }, [client, instance]);

  return <WatchupContext.Provider value={instance}>{children}</WatchupContext.Provider>;
}
