export { WatchupProvider }           from './WatchupProvider.js';
export type { WatchupProviderProps } from './WatchupProvider.js';

export { WatchupContext }            from './context.js';

export { WatchupErrorBoundary } from './ErrorBoundary.js';

export { useWatchup, useTrack, useStartTrace } from './hooks.js';

// Re-export core types so consumers only need one package
export type {
  WatchupOptions,
  TracePayload,
  ErrorPayload,
  EventPayload,
  IngestBatch,
} from '@watchupltd/browser';
