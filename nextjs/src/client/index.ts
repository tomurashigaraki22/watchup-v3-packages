'use client';

export { WatchupProvider }               from './WatchupProvider.js';
export type { WatchupNextProviderProps } from './WatchupProvider.js';

// React hooks work unchanged in App Router client components.
export {
  useWatchup,
  useTrack,
  useStartTrace,
  useIdentify,
  usePageView,
  useFlag,
  useVariant,
  WatchupErrorBoundary,
} from '@watchupltd/react';

export type {
  WatchupOptions,
  WatchupUser,
  TracePayload,
  ErrorPayload,
  EventPayload,
  LogContext,
  LogLevel,
  LoggingOptions,
  FeatureFlag,
  FlagContext,
} from '@watchupltd/browser';
