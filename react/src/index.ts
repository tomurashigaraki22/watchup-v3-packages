export { WatchupProvider }           from './WatchupProvider.js';
export type { WatchupProviderProps } from './WatchupProvider.js';

export { WatchupContext }            from './context.js';

export { WatchupErrorBoundary } from './ErrorBoundary.js';

export {
  useWatchup,
  useTrack,
  useStartTrace,
  useIdentify,
  useFlag,
  useVariant,
} from './hooks.js';

// Re-export core types so consumers only need one package
export type {
  WatchupOptions,
  TracePayload,
  ErrorPayload,
  EventPayload,
  IngestBatch,
  WatchupUser,
  LogContext,
  LogLevel,
  LoggingOptions,
  FeatureFlag,
  FlagContext,
} from '@watchupltd/browser';
