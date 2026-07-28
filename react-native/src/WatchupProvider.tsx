import React, { useEffect, useRef, type ReactNode } from 'react';
import { WatchupReactNative } from './client.js';
import { WatchupContext } from './context.js';
import type { WatchupReactNativeOptions } from './types.js';

export interface WatchupProviderProps {
  apiKey: string;
  options?: Omit<WatchupReactNativeOptions, 'apiKey'>;
  children: ReactNode;
}

export function WatchupProvider({ apiKey, options, children }: WatchupProviderProps) {
  const instanceRef = useRef<WatchupReactNative | null>(null);

  if (!instanceRef.current) {
    instanceRef.current = new WatchupReactNative({ apiKey, ...options });
  }

  useEffect(() => {
    return () => {
      instanceRef.current?.shutdown();
      instanceRef.current = null;
    };
  }, []);

  return (
    <WatchupContext.Provider value={instanceRef.current}>
      {children}
    </WatchupContext.Provider>
  );
}
