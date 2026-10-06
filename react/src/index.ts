export { WatchupProvider }           from './WatchupProvider.js';
export type { WatchupProviderProps } from './WatchupProvider.js';

export { WatchupContext }            from './context.js';
export { createNoopWatchup }         from './noop.js';

export { WatchupErrorBoundary }      from './ErrorBoundary.js';
export type { WatchupErrorBoundaryProps } from './ErrorBoundary.js';

export {
  useWatchup,
  useTrack,
  useStartTrace,
  useIdentify,
  usePageView,
  useFlag,
  useVariant,
} from './hooks.js';

export { SDK_NAME, SDK_VERSION } from './version.js';

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
  Diagnostic,
  FlushResult,
} from '@watchupltd/browser';
