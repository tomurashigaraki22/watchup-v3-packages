// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/node  ·  types
// ─────────────────────────────────────────────────────────────────────────────

import type { Diagnostic } from '@watchupltd/core';

export type {
  Diagnostic,
  DiagnosticType,
  FlushResult,
  FeatureFlag,
  FlagContext,
  FlagVariant,
  FlagTargetingRule,
} from '@watchupltd/core';

export interface WatchupUser {
  id: string | number;
  email?: string;
  name?: string;
  [key: string]: unknown;
}

/** Log levels for structured application logs. */
export type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'critical';

/** Opt-in controls for application logging. */
export interface LoggingOptions {
  /** Enable `captureLog()`. Default: `false`. */
  enabled?: boolean;
  /** Forward console methods to `captureLog()`. Default: `false`. */
  captureConsole?: boolean;
  /** Lowest severity that is sent. Default: `'debug'`. */
  minLevel?: LogLevel;
}

/**
 * Options passed to `new Watchup(options)`.
 */
export interface WatchupOptions {
  /**
   * Your project's API key, found in the Watchup dashboard under
   * Project Settings → API Keys.
   *
   * Format: `wup_live_xxxxxxxxxxxx`
   */
  apiKey: string;

  /**
   * Watchup ingest base URL.
   * Defaults to `https://api.watchup.site`.
   * Override for self-hosted deployments.
   */
  baseUrl?: string;

  /**
   * How often (ms) to flush the event queue to the API.
   * Default: `5000` (5 seconds).
   */
  flushInterval?: number;

  /**
   * Maximum items per request (capped at the server's 100).
   * Default: `100`.
   */
  maxBatchSize?: number;

  /**
   * Maximum items held in memory while the API is unreachable. The oldest
   * events are dropped first, errors last. Default: `1000`.
   */
  maxQueueSize?: number;

  /** Extra keys to redact in captured context, on top of the built-in list. */
  redactKeys?: string[];

  /** Service name attached to traces, errors and logs (e.g. `"api"`). */
  service?: string;

  /**
   * Called for SDK delivery diagnostics (truncation, retries, drops).
   * Never receives captured data or keys.
   */
  onDiagnostic?: (diagnostic: Diagnostic) => void;

  /**
   * Flush on SIGTERM/SIGINT and `beforeExit`. If your app has its own signal
   * handlers they still decide when to exit; otherwise WatchUp re-raises the
   * signal after flushing. Default: `true`.
   */
  handleSignals?: boolean;

  /**
   * Capture `uncaughtException` and `unhandledRejection`, flush for up to
   * `shutdownTimeout`, then exit with code 1 (Node's default behaviour).
   * Default: `false`.
   */
  captureUnhandled?: boolean;

  /** Max ms to wait for delivery during shutdown. Default: `5000`. */
  shutdownTimeout?: number;

  /** Feature-flag refresh interval in ms. Default: `30000`. `0` disables polling. */
  flagRefreshInterval?: number;

  /**
   * Log SDK warnings and HTTP errors to `console.warn`.
   * Default: `false`.
   */
  debug?: boolean;

  /**
   * Runtime environment label attached to every payload.
   * Defaults to `process.env.NODE_ENV ?? 'production'`.
   */
  environment?: string;

  /**
   * App version / git SHA attached to every payload.
   * Useful for correlating errors to deploys.
   */
  release?: string;

  /**
   * Fraction of requests to capture as traces (0–1).
   * `1` = 100 %, `0.1` = 10 %. Default: `1`.
   */
  sampleRate?: number;

  /** Opt-in structured application logging. */
  logging?: LoggingOptions;
}

// ── Ingest shapes ─────────────────────────────────────────────────────────────

/** A single captured request trace. */
export interface TracePayload {
  /** Human-readable span name, e.g. `"GET /api/users/:id"`. */
  span: string;
  /** Trace kind. `"http"` for requests, `"db"` for queries, `"custom"` otherwise. */
  type?: 'http' | 'function' | 'db' | 'custom';
  /** End-to-end duration in milliseconds. */
  ms: number;
  /** HTTP status code, or a synthetic code for non-HTTP spans (200/400/500). */
  status_code: number;
  /** Derived health status. */
  status: 'ok' | 'warn' | 'err';
  /** ISO-8601 timestamp of when the request finished. */
  timestamp: string;
  environment?: string;
  release?: string;
  /** Arbitrary extra metadata (user ID, tenant, feature flag…). */
  meta?: Record<string, unknown>;
  user?: WatchupUser;
}

/** A captured error or exception. */
export interface ErrorPayload {
  /** Error message string. */
  message: string;
  /** Error class name, e.g. `"TypeError"`. */
  type?: string;
  /** Severity level. */
  level: 'debug' | 'info' | 'warning' | 'error' | 'fatal';
  /** Route that produced the error, e.g. `"POST /api/orders"`. */
  route?: string;
  /** Full stack trace. */
  stack?: string;
  /** Arbitrary structured context (request headers, user ID…). */
  context?: Record<string, unknown>;
  /** ISO-8601 timestamp. */
  timestamp: string;
  environment?: string;
  release?: string;
  user?: WatchupUser;
}

/** A custom analytics event. */
export interface EventPayload {
  /** Event name, e.g. `"user.signed_up"`. */
  name: string;
  /** Arbitrary event properties. Must be JSON-serialisable. */
  properties?: Record<string, unknown>;
  /** ISO-8601 timestamp of when the event occurred. */
  occurred_at: string;
}

/** Shape of a single HTTP batch request body. */
export interface IngestBatch {
  traces?: TracePayload[];
  errors?: ErrorPayload[];
  events?: EventPayload[];
}

export type LogContext = Record<string, unknown> & {
  level?: LogLevel;
  route?: string;
};

/** Per-request context kept in AsyncLocalStorage. */
export interface RequestContext {
  requestId: string;
  traceId?: string;
  method?: string;
  route?: string;
  user: WatchupUser | null;
}
