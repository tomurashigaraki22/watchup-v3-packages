// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/node  ·  public exports
// ─────────────────────────────────────────────────────────────────────────────

export { Watchup } from './watchup.js';
export { SDK_NAME, SDK_VERSION } from './version.js';
export { normalisePath } from './middleware.js';

export type {
  WatchupOptions,
  WatchupUser,
  TracePayload,
  ErrorPayload,
  EventPayload,
  IngestBatch,
  LogContext,
  LogLevel,
  LoggingOptions,
  RequestContext,
  FeatureFlag,
  FlagContext,
  FlagVariant,
  FlagTargetingRule,
  Diagnostic,
  DiagnosticType,
  FlushResult,
} from './types.js';
