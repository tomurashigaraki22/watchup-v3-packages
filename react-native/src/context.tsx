import { createContext, useContext } from 'react';
import type { WatchupReactNative } from './client.js';

export const WatchupContext = createContext<WatchupReactNative | null>(null);

export function useWatchupContext(): WatchupReactNative {
  const instance = useContext(WatchupContext);
  if (!instance) {
    throw new Error('[watchup] useWatchup() must be used inside <WatchupProvider>.');
  }
  return instance;
}
