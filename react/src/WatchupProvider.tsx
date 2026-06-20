// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/react  ·  WatchupProvider
//
// Initialises the Watchup browser SDK once and makes it available to the
// entire React tree via context.  Safe to render in strict-mode — the client
// is created with a ref so it survives double-invocation.
// ─────────────────────────────────────────────────────────────────────────────

'use client'; // Next.js App Router guard (ignored in plain React)

import React, { useEffect, useRef, type ReactNode } from 'react';
import { Watchup, type WatchupOptions } from '@watchupltd/browser';
import { WatchupContext } from './context.js';

export interface WatchupProviderProps {
  /** Watchup project API key. */
  apiKey: string;
  /** Full SDK options (excluding apiKey which is a top-level prop). */
  options?: Omit<WatchupOptions, 'apiKey'>;
  children: ReactNode;
}

/**
 * Mount this once near the root of your application.
 *
 * @example
 * <WatchupProvider apiKey="wup_live_xxx">
 *   <App />
 * </WatchupProvider>
 */
export function WatchupProvider({ apiKey, options, children }: WatchupProviderProps) {
  // Use a ref so strict-mode double-mount doesn't create two instances
  const instanceRef = useRef<Watchup | null>(null);

  if (!instanceRef.current) {
    instanceRef.current = new Watchup({ apiKey, ...options });
  }

  useEffect(() => {
    // Flush + clean up on unmount (HMR, test teardowns, etc.)
    return () => {
      instanceRef.current?.shutdown();
      instanceRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <WatchupContext.Provider value={instanceRef.current}>
      {children}
    </WatchupContext.Provider>
  );
}
