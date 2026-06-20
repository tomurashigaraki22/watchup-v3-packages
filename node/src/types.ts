// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/node  ·  types
// ─────────────────────────────────────────────────────────────────────────────

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
   * Maximum number of items of each type to hold before forcing a flush.
   * Default: `100`.
   */
  maxBatchSize?: number;

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
}

// ── Ingest shapes ─────────────────────────────────────────────────────────────

/** A single captured request trace. */
export interface TracePayload {
  /** Human-readable span name, e.g. `"GET /api/users/:id"`. */
  span: string;
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
}

/** A captured error or exception. */
export interface ErrorPayload {
  /** Error message string. */
  message: string;
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
