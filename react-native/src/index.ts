export { WatchupReactNative, Watchup } from './client.js';
export { WatchupProvider, type WatchupProviderProps } from './WatchupProvider.js';
export {
  useIdentify,
  useStartTrace,
  useTrack,
  useWatchup,
  useScreen,
  useNavigationTracking,
} from './hooks.js';
export { SDK_NAME, SDK_VERSION } from './version.js';
export type {
  AutoCaptureOptions,
  ErrorPayload,
  EventPayload,
  IngestBatch,
  LogContext,
  LogLevel,
  LoggingOptions,
  QueueStorage,
  TracePayload,
  WatchupReactNativeOptions,
  WatchupUser,
  Diagnostic,
  DiagnosticType,
  FlushResult,
} from './types.js';
