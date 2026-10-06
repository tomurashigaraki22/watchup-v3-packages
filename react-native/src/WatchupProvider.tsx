import { useEffect, useRef, useState, type ReactNode } from 'react';
import { WatchupReactNative } from './client.js';
import { WatchupContext } from './context.js';
import type { WatchupReactNativeOptions } from './types.js';

export interface WatchupProviderProps {
  /** Your public project key (`wup_pub_…`). */
  apiKey: string;
  options?: Omit<WatchupReactNativeOptions, 'apiKey'>;
  /** Use a client you created yourself (it is not shut down on unmount). */
  client?: WatchupReactNative;
  children: ReactNode;
}

/**
 * Mount once at the root of the app. StrictMode-safe: the development
 * unmount/remount cycle keeps the same client instead of shutting it down.
 */
export function WatchupProvider({ apiKey, options, client, children }: WatchupProviderProps) {
  const [instance] = useState(() => client ?? new WatchupReactNative({ apiKey, ...options }));
  const pendingShutdown = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pendingShutdown.current) {
      clearTimeout(pendingShutdown.current);
      pendingShutdown.current = null;
    }
    return () => {
      if (client) return;
      pendingShutdown.current = setTimeout(() => void instance.shutdown(), 100);
    };
  }, [client, instance]);

  return <WatchupContext.Provider value={instance}>{children}</WatchupContext.Provider>;
}
