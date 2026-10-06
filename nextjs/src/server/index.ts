export { initWatchup, getWatchup, registerWatchup } from './watchup.js';
export { withWatchupRoute, withWatchupApi, captureRequestError } from './withWatchupRoute.js';
export type { RouteOptions } from './withWatchupRoute.js';

export type {
  WatchupOptions,
  WatchupUser,
  TracePayload,
  ErrorPayload,
  EventPayload,
  LogContext,
  LogLevel,
  LoggingOptions,
  FlagContext,
  Diagnostic,
  FlushResult,
} from '@watchupltd/node';
