'use client';

export { WatchupProvider }          from './WatchupProvider.js';
export type { WatchupNextProviderProps } from './WatchupProvider.js';

// Re-export react hooks — they all work fine in App Router client components
export {
  useWatchup,
  useTrack,
  useStartTrace,
  WatchupErrorBoundary,
} from '@watchupltd/react';

export type {
  WatchupOptions,
  TracePayload,
  ErrorPayload,
  EventPayload,
} from '@watchupltd/browser';
